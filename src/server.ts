import express from "express";
import cors from "cors";
import path from "node:path";
import { MetalpriceClient } from "./metalpriceClient.js";

type MetalCache = {
	usdPerOunce: number;
	usdPerGram: number;
	usdPerPound?: number;
	usdPerMetricTon?: number;
	timestamp: number;
};

const app = express();
app.use(cors());

const client = new MetalpriceClient();
const MIN_REFRESH_MS = 60 * 1000; // 1 minute baseline minimum
const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // plan-aware interval: ~45 minutes for Essential (<= ~960 requests/month)

// Ounce-to-gram conversion: precious metals use troy ounces; others use avoirdupois ounces
const TROY_OUNCE_GRAMS = 31.1034768;
const OUNCE_GRAMS = 28.349523125;
const POUND_GRAMS = 453.59237;
const METRIC_TON_GRAMS = 1_000_000; // 1000 kg
const PRECIOUS = new Set(["XAU", "XAG", "XPT", "XPD"]);

const caches = new Map<string, MetalCache>();
const lastFetchBySymbol = new Map<string, number>();
type SeriesPoint = { t: number; v: number };
const timeseriesBySymbol = new Map<string, SeriesPoint[]>();
const MAX_SERIES_POINTS = 500;

async function refreshSymbolCache(symbol: string) {
	const now = Date.now();
	const last = lastFetchBySymbol.get(symbol) ?? 0;
	if (caches.has(symbol) && now - last < MIN_REFRESH_MS) return;

	const resp = await client.fetchLatest({ base: "USD", currencies: [symbol] });
	if (!resp.success || !resp.rates || resp.rates[symbol] == null) {
		throw new Error(`Failed to fetch ${symbol}: ${resp.error?.code} ${resp.error?.info}`);
	}
	const unitsPerUsd = resp.rates[symbol]; // how many units of metal per 1 USD
	const usdPerOunce = 1 / unitsPerUsd;
	const gramsPerOunce = PRECIOUS.has(symbol) ? TROY_OUNCE_GRAMS : OUNCE_GRAMS;
	const usdPerGram = usdPerOunce / gramsPerOunce;

	const base: MetalCache = { usdPerOunce, usdPerGram, timestamp: now };
	if (symbol === "XCU" || symbol === "NI") {
		base.usdPerPound = usdPerGram * POUND_GRAMS;
	}
	if (symbol === "XCO") {
		base.usdPerMetricTon = usdPerGram * METRIC_TON_GRAMS;
	}

	caches.set(symbol, base);
	lastFetchBySymbol.set(symbol, now);
}

async function refreshAllSymbols() {
	const now = Date.now();
	const symbols = TRACKED.map(([sym]) => sym);
	const resp = await client.fetchLatest({ base: "USD", currencies: symbols });
	if (!resp.success || !resp.rates) {
		throw new Error(`Failed multi fetch: ${resp.error?.code} ${resp.error?.info}`);
	}
	for (const symbol of symbols) {
		const rate = resp.rates[symbol as keyof typeof resp.rates];
		if (rate == null) continue;
		const unitsPerUsd = rate;
		const usdPerOunce = 1 / unitsPerUsd;
		const gramsPerOunce = PRECIOUS.has(symbol) ? TROY_OUNCE_GRAMS : OUNCE_GRAMS;
		const usdPerGram = usdPerOunce / gramsPerOunce;

		const base: MetalCache = { usdPerOunce, usdPerGram, timestamp: now };
		if (symbol === "XCU" || symbol === "NI") {
			base.usdPerPound = usdPerGram * POUND_GRAMS;
		}
		if (symbol === "XCO") {
			base.usdPerMetricTon = usdPerGram * METRIC_TON_GRAMS;
		}
		caches.set(symbol, base);
		lastFetchBySymbol.set(symbol, now);

		// Record a display-value time series point
		const display = getDisplayValue(symbol, base);
		const arr = timeseriesBySymbol.get(symbol) ?? [];
		if (arr.length === 0 || now - arr[arr.length - 1].t > 60 * 1000) {
			arr.push({ t: now, v: display });
			if (arr.length > MAX_SERIES_POINTS) arr.splice(0, arr.length - MAX_SERIES_POINTS);
			timeseriesBySymbol.set(symbol, arr);
		}
	}
}

function getDisplayValue(symbol: string, cache: MetalCache): number {
	if (symbol === "XCU" || symbol === "NI") return cache.usdPerPound ?? 0;
	if (symbol === "XCO") return cache.usdPerMetricTon ?? 0;
	return cache.usdPerOunce;
}

function routeFor(symbol: string, name: string) {
	app.get(`/api/${name}/latest`, async (_req, res) => {
		try {
			// try to serve cache; if too old, refresh just this symbol as a fallback
			const last = lastFetchBySymbol.get(symbol) ?? 0;
			if (!caches.has(symbol) || Date.now() - last > REFRESH_INTERVAL_MS) {
				await refreshSymbolCache(symbol);
			}
			const data = caches.get(symbol);
			if (!data) return res.status(503).json({ success: false, error: "no data" });
			return res.json({ success: true, data });
		} catch (err: any) {
			return res.status(502).json({ success: false, error: String(err?.message || err) });
		}
	});

	app.get(`/api/${name}/timeseries`, (_req, res) => {
		const limitParam = Number((_req.query?.limit as string) ?? "100");
		const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_SERIES_POINTS) : 100;
		const series = timeseriesBySymbol.get(symbol) ?? [];
		const slice = series.slice(-limit);
		return res.json({ success: true, data: { points: slice } });
	});
}

// periodic refresh for tracked symbols
const TRACKED: Array<[string, string]> = [
	["XAU", "gold"],
	["XAG", "silver"],
	["XPT", "platinum"],
	["XPD", "palladium"],
	["XCU", "copper"],
	["NI", "nickel"],
	["XCO", "cobalt"],
];

for (const [sym, name] of TRACKED) routeFor(sym, name);

// Kick off immediate fetch and periodic multi-symbol refresh to align with plan limits
refreshAllSymbols().catch(() => {/* ignore startup error */});
setInterval(() => {
	refreshAllSymbols().catch(() => {
		/* ignore periodic errors */
	});
}, REFRESH_INTERVAL_MS).unref();

// Seed timeseries with 30 days of history on startup (one-time best effort)
(async function seedHistory() {
	try {
		const end = new Date();
		const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
		const fmt = (d: Date) => d.toISOString().slice(0, 10);
		const symbols = TRACKED.map(([s]) => s);
		const tf = await client.fetchTimeframe({
			start_date: fmt(start),
			end_date: fmt(end),
			base: "USD",
			currencies: symbols,
		});
		if (!tf.success || !tf.rates) return;
		// tf.rates is date -> { SYMBOL: unitsPerUsd }
		const dates = Object.keys(tf.rates).sort();
		for (const date of dates) {
			const dayRates = tf.rates[date]!;
			const t = new Date(date).getTime();
			for (const symbol of symbols) {
				const unitsPerUsd = dayRates[symbol as keyof typeof dayRates];
				if (unitsPerUsd == null) continue;
				const usdPerOunce = 1 / unitsPerUsd;
				const gramsPerOunce = PRECIOUS.has(symbol) ? TROY_OUNCE_GRAMS : OUNCE_GRAMS;
				const usdPerGram = usdPerOunce / gramsPerOunce;
				const base: MetalCache = { usdPerOunce, usdPerGram, timestamp: t };
				if (symbol === "XCU" || symbol === "NI") base.usdPerPound = usdPerGram * POUND_GRAMS;
				if (symbol === "XCO") base.usdPerMetricTon = usdPerGram * METRIC_TON_GRAMS;
				const value = getDisplayValue(symbol, base);
				const arr = timeseriesBySymbol.get(symbol) ?? [];
				arr.push({ t, v: value });
				timeseriesBySymbol.set(symbol, arr);
			}
		}
		for (const [symbol, arr] of timeseriesBySymbol) {
			arr.sort((a, b) => a.t - b.t);
			if (arr.length > MAX_SERIES_POINTS) arr.splice(0, arr.length - MAX_SERIES_POINTS);
		}
	} catch {
		/* ignore seed errors to avoid blocking startup */
	}
})();

// Serve static demo page from public/
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});


