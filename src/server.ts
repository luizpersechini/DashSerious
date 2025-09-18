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
const MIN_REFRESH_MS = 60 * 1000; // 1 minute by default; adjust per plan

// Ounce-to-gram conversion: precious metals use troy ounces; others use avoirdupois ounces
const TROY_OUNCE_GRAMS = 31.1034768;
const OUNCE_GRAMS = 28.349523125;
const POUND_GRAMS = 453.59237;
const METRIC_TON_GRAMS = 1_000_000; // 1000 kg
const PRECIOUS = new Set(["XAU", "XAG", "XPT", "XPD"]);

const caches = new Map<string, MetalCache>();
const lastFetchBySymbol = new Map<string, number>();

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

function routeFor(symbol: string, name: string) {
	app.get(`/api/${name}/latest`, async (_req, res) => {
		try {
			await refreshSymbolCache(symbol);
			const data = caches.get(symbol);
			if (!data) return res.status(503).json({ success: false, error: "no data" });
			return res.json({ success: true, data });
		} catch (err: any) {
			return res.status(502).json({ success: false, error: String(err?.message || err) });
		}
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

setInterval(() => {
	Promise.all(TRACKED.map(([sym]) => refreshSymbolCache(sym))).catch(() => {
		/* ignore periodic errors */
	});
}, MIN_REFRESH_MS).unref();

// Serve static demo page from public/
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});


