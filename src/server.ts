import express from "express";
import cors from "cors";
import path from "node:path";
import { MetalpriceClient } from "./metalpriceClient.js";
import { fetchChange } from "./metalpriceClient.js";
import { config } from "./config.js";
import { hydrateTimeseries, persistTimeseries as persistTS, registerGracefulPersist } from "./storage.js";

type MetalCache = {
	usdPerOunce: number;
	usdPerGram: number;
	usdPerPound?: number;
	usdPerMetricTon?: number;
	fxUsdBrl?: number;
	timestamp: number;
};

const app = express();
app.use(cors());

const client = new MetalpriceClient();
const MIN_REFRESH_MS = 60 * 1000; // 1 minute baseline minimum
function resolvePlanRefreshMs(): number {
  if (config.manualRefreshMinutes && config.manualRefreshMinutes > 0) {
    return config.manualRefreshMinutes * 60 * 1000;
  }
  // Defaults per plan based on docs (approx):
  // Essential: 30 min; Basic: 10 min; Basic Plus/Pro: 60s; Pro Plus: 30s; Business: 15s
  switch (config.metalpricePlan) {
    case "business":
      return 15 * 1000;
    case "professionalplus":
    case "proplus":
      return 30 * 1000;
    case "professional":
    case "basicplus":
      return 60 * 1000;
    case "basic":
      return 10 * 60 * 1000;
    case "essential":
    default:
      return 30 * 60 * 1000;
  }
}
const REFRESH_INTERVAL_MS = resolvePlanRefreshMs();

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
const MAX_SERIES_POINTS = 4000; // ~10 years of daily data

// Single in-flight refresh guard: collapses concurrent /latest cache-miss paths into one upstream call.
let inFlightRefresh: Promise<void> | null = null;
function coalesceRefresh(): Promise<void> {
	if (!inFlightRefresh) {
		inFlightRefresh = refreshAllSymbols().finally(() => {
			inFlightRefresh = null;
		});
	}
	return inFlightRefresh;
}

async function persistTimeseries(): Promise<void> {
	await persistTS(timeseriesBySymbol);
}

// Readiness: server accepts connections immediately, but /api handlers wait until the first
// refresh resolves (bounded) so we never serve a cold empty cache on first load.
const READY_TIMEOUT_MS = 10_000;
const bootStart = Date.now();
let seedComplete = false;
const ready: Promise<void> = (async () => {
	// Hydrate from disk first so charts aren't empty during the initial fetch window.
	const h = await hydrateTimeseries(timeseriesBySymbol);
	if (h.loaded) console.log(`[storage] hydrated ${h.symbols} symbols from disk`);
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, READY_TIMEOUT_MS);
		coalesceRefresh()
			.catch(() => {/* boot anyway; handler will surface per-request errors */})
			.finally(() => {
				clearTimeout(timer);
				resolve();
			});
	});
})();

async function refreshSymbolCache(symbol: string) {
	const now = Date.now();
	const last = lastFetchBySymbol.get(symbol) ?? 0;
	if (caches.has(symbol) && now - last < MIN_REFRESH_MS) return;

	const resp = await client.fetchLatest({ base: "USD", currencies: [symbol] });
	if (!resp.success || !resp.rates || resp.rates[symbol] == null) {
		throw new Error(`Failed to fetch ${symbol}: ${resp.error?.code} ${resp.error?.info}`);
	}
	const unitsPerUsd = resp.rates[symbol]; // how many units of symbol per 1 USD

	if (symbol === "BRL") {
		const base: MetalCache = { usdPerOunce: 0, usdPerGram: 0, fxUsdBrl: unitsPerUsd, timestamp: now };
		caches.set(symbol, base);
		lastFetchBySymbol.set(symbol, now);
		return;
	}
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
		if (symbol === "BRL") {
			const base: MetalCache = { usdPerOunce: 0, usdPerGram: 0, fxUsdBrl: unitsPerUsd, timestamp: now };
			caches.set(symbol, base);
			lastFetchBySymbol.set(symbol, now);
            const arr = timeseriesBySymbol.get(symbol) ?? [];
            const lastPoint = arr[arr.length - 1];
            if (!lastPoint || now - lastPoint.t > 60 * 1000) {
                arr.push({ t: now, v: unitsPerUsd });
                if (arr.length > MAX_SERIES_POINTS) arr.splice(0, arr.length - MAX_SERIES_POINTS);
                timeseriesBySymbol.set(symbol, arr);
            }
			continue;
		}
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
        const lastPoint = arr[arr.length - 1];
        if (!lastPoint || now - lastPoint.t > 60 * 1000) {
            arr.push({ t: now, v: display });
            if (arr.length > MAX_SERIES_POINTS) arr.splice(0, arr.length - MAX_SERIES_POINTS);
            timeseriesBySymbol.set(symbol, arr);
        }
	}
}

function getDisplayValue(symbol: string, cache: MetalCache): number {
	if (symbol === "XCU" || symbol === "NI") return cache.usdPerPound ?? 0;
	if (symbol === "XCO") return cache.usdPerMetricTon ?? 0;
	if (symbol === "BRL") return cache.fxUsdBrl ?? 0;
	return cache.usdPerOunce;
}

async function handleLatest(symbol: string, req: express.Request, res: express.Response) {
	try {
		// Serve cache; if too old, coalesce all waiters onto a single multi-symbol refresh
		// so first-load never fans out into 8 concurrent single-symbol upstream calls.
		const last = lastFetchBySymbol.get(symbol) ?? 0;
		if (!caches.has(symbol) || Date.now() - last > REFRESH_INTERVAL_MS) {
			await coalesceRefresh();
		}
		const data = caches.get(symbol);
		if (!data) return res.status(503).json({ success: false, error: "no data" });
		// Weak ETag derived from the cache timestamp — cheap and exact.
		const etag = `W/"${symbol}-${data.timestamp}"`;
		res.setHeader("Cache-Control", "public, max-age=30");
		res.setHeader("ETag", etag);
		if (req.headers["if-none-match"] === etag) {
			return res.status(304).end();
		}
		return res.json({ success: true, data });
	} catch (err: any) {
		return res.status(502).json({ success: false, error: String(err?.message || err) });
	}
}

function handleTimeseries(symbol: string, req: express.Request, res: express.Response) {
	res.setHeader("Cache-Control", "no-store");
	const series = timeseriesBySymbol.get(symbol) ?? [];
	const sinceTs = Number(req.query?.since_ts ?? 0);
	let points: SeriesPoint[];
	if (Number.isFinite(sinceTs) && sinceTs > 0) {
		points = series.filter(p => p.t >= sinceTs);
	} else {
		const limitParam = Number((req.query?.limit as string) ?? "100");
		const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_SERIES_POINTS) : 100;
		points = series.slice(-limit);
	}
	return res.json({ success: true, data: { points, seedPending: !seedComplete } });
}

async function handleChange(symbol: string, req: express.Request, res: express.Response) {
	try {
		const date_type = (req.query?.date_type as string) || "month";
		const r = await fetchChange({ date_type: date_type as any, base: "USD", currencies: [symbol] });
		return res.json(r);
	} catch (e: any) {
		return res.status(500).json({ success: false, error: String(e?.message || e) });
	}
}

function routeFor(symbol: string, name: string) {
	app.get(`/api/${name}/latest`, (req, res) => handleLatest(symbol, req, res));
	app.get(`/api/${name}/timeseries`, (req, res) => handleTimeseries(symbol, req, res));
	app.get(`/api/${name}/change`, (req, res) => handleChange(symbol, req, res));
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
	["BRL", "brl"],
];

const NAME_TO_SYMBOL = new Map<string, string>(TRACKED.map(([s, n]) => [n, s]));

// Readiness gate: block /api handlers until the initial refresh completes (bounded),
// so the very first request never sees an empty cache.
app.use("/api", async (_req, _res, next) => {
	try { await ready; } catch { /* surface per-request */ }
	next();
});

// Parameterized routes (Phase 4a). The per-name aliases below remain for backward compatibility.
app.get("/api/metal/:name/latest", (req, res) => {
	const symbol = NAME_TO_SYMBOL.get(String(req.params.name || "").toLowerCase());
	if (!symbol) return res.status(404).json({ success: false, error: "unknown metal" });
	return handleLatest(symbol, req, res);
});
app.get("/api/metal/:name/timeseries", (req, res) => {
	const symbol = NAME_TO_SYMBOL.get(String(req.params.name || "").toLowerCase());
	if (!symbol) return res.status(404).json({ success: false, error: "unknown metal" });
	return handleTimeseries(symbol, req, res);
});
app.get("/api/metal/:name/change", (req, res) => {
	const symbol = NAME_TO_SYMBOL.get(String(req.params.name || "").toLowerCase());
	if (!symbol) return res.status(404).json({ success: false, error: "unknown metal" });
	return handleChange(symbol, req, res);
});

for (const [sym, name] of TRACKED) routeFor(sym, name);

// Aggregated timeseries: returns all tracked symbols in one response.
// Format: { success: true, symbols: { XAU: [{t,v},...], ... } }
app.get("/api/allmetals/timeseries", (req, res) => {
	const limitParam = Number((req.query?.limit as string) ?? "0");
	const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_SERIES_POINTS) : 0;
	const symbols: Record<string, SeriesPoint[]> = {};
	for (const [sym] of TRACKED) {
		const arr = timeseriesBySymbol.get(sym) ?? [];
		symbols[sym] = limit > 0 ? arr.slice(-limit) : arr.slice();
	}
	return res.json({ success: true, symbols });
});

// Health: unblocked (not under /api), usable as a Cloud Run readiness probe.
app.get("/health", (_req, res) => {
	res.setHeader("Cache-Control", "no-store");
	return res.json({
		ok: true,
		cacheWarm: caches.size === TRACKED.length,
		cachedSymbols: caches.size,
		seedComplete,
		uptimeMs: Date.now() - bootStart,
	});
});

// Manual refresh endpoint (forces immediate cache clear and refetch)
app.post("/api/refresh", async (_req, res) => {
	try {
		// Clear all caches to force fresh data
		caches.clear();
		lastFetchBySymbol.clear();
		
		// Fetch all symbols immediately
		await refreshAllSymbols();
		
		return res.json({ success: true, message: "Data refreshed successfully" });
	} catch (err: any) {
		return res.status(500).json({ 
			success: false, 
			error: String(err?.message || err) 
		});
	}
});

// Initial refresh is already kicked off by the `ready` promise above via coalesceRefresh().
// Schedule periodic multi-symbol refresh to stay aligned with plan limits.
setInterval(() => {
	coalesceRefresh().catch(() => {
		/* ignore periodic errors */
	});
}, REFRESH_INTERVAL_MS).unref();

// Seed timeseries with historical data on startup. Fetches only missing date ranges
// (backfill + top-up) to avoid re-hitting the API for data already on disk.
(async function seedHistory() {
	try {
		const SEED_DEPTH_DAYS = config.seedDepthDays;
		const CHUNK_DAYS = 365; // MetalpriceAPI timeframe max window per call
		const DAY_MS = 24 * 60 * 60 * 1000;
		const symbols = TRACKED.map(([s]) => s);
		const fmt = (d: Date) => d.toISOString().slice(0, 10);

		const today = new Date();
		today.setUTCHours(0, 0, 0, 0);
		const targetStart = new Date(today.getTime() - SEED_DEPTH_DAYS * DAY_MS);
		const yesterday = new Date(today.getTime() - DAY_MS);

		// Determine overall coverage from in-memory data (hydrated from disk or prior run).
		let oldestMs = Infinity;
		let newestMs = -Infinity;
		for (const [, arr] of timeseriesBySymbol) {
			if (arr.length === 0) continue;
			if (arr[0]!.t < oldestMs) oldestMs = arr[0]!.t;
			if (arr[arr.length - 1]!.t > newestMs) newestMs = arr[arr.length - 1]!.t;
		}
		const hasData = oldestMs !== Infinity;

		// Build ordered list of [start, end] date ranges to fetch.
		const ranges: [Date, Date][] = [];

		function pushChunks(from: Date, to: Date) {
			let cur = new Date(from);
			while (cur <= to) {
				const end = new Date(Math.min(cur.getTime() + (CHUNK_DAYS - 1) * DAY_MS, to.getTime()));
				ranges.push([new Date(cur), end]);
				cur = new Date(end.getTime() + DAY_MS);
			}
		}

		if (!hasData) {
			// No data at all — fetch newest first so the most recent window is available immediately.
			pushChunks(targetStart, yesterday);
			ranges.reverse();
		} else {
			// Backfill: we need older data than what's on disk.
			const oldestDate = new Date(oldestMs);
			oldestDate.setUTCHours(0, 0, 0, 0);
			if (oldestDate > new Date(targetStart.getTime() + 2 * DAY_MS)) {
				pushChunks(targetStart, new Date(oldestDate.getTime() - DAY_MS));
			}
			// Top-up: we need more recent data than what's on disk.
			const newestDate = new Date(newestMs);
			newestDate.setUTCHours(0, 0, 0, 0);
			const dayAfterNewest = new Date(newestDate.getTime() + DAY_MS);
			if (dayAfterNewest <= yesterday) {
				pushChunks(dayAfterNewest, yesterday);
			}
		}

		if (ranges.length === 0) {
			console.log(`📊 Historical data already up to date (${[...timeseriesBySymbol.values()][0]?.length ?? 0} points)`);
			seedComplete = true;
			return;
		}

		console.log(`📊 Fetching ${ranges.length} chunk(s) covering up to ${SEED_DEPTH_DAYS} days of history...`);

		function ingestChunk(rates: Record<string, Record<string, number>>) {
			for (const date of Object.keys(rates).sort()) {
				const dayRates = rates[date]!;
				const t = new Date(date).getTime();
				for (const symbol of symbols) {
					const unitsPerUsd = dayRates[symbol as keyof typeof dayRates];
					if (unitsPerUsd == null) continue;
					let v: number;
					if (symbol === "BRL") {
						v = unitsPerUsd;
					} else {
						const usdPerOunce = 1 / unitsPerUsd;
						const gramsPerOunce = PRECIOUS.has(symbol) ? TROY_OUNCE_GRAMS : OUNCE_GRAMS;
						const usdPerGram = usdPerOunce / gramsPerOunce;
						const base: MetalCache = { usdPerOunce, usdPerGram, timestamp: t };
						if (symbol === "XCU" || symbol === "NI") base.usdPerPound = usdPerGram * POUND_GRAMS;
						if (symbol === "XCO") base.usdPerMetricTon = usdPerGram * METRIC_TON_GRAMS;
						v = getDisplayValue(symbol, base);
					}
					const arr = timeseriesBySymbol.get(symbol) ?? [];
					arr.push({ t, v });
					timeseriesBySymbol.set(symbol, arr);
				}
			}
		}

		for (let i = 0; i < ranges.length; i++) {
			const [start, end] = ranges[i]!;
			const tf = await client.fetchTimeframe({ start_date: fmt(start), end_date: fmt(end), base: "USD", currencies: symbols });
			if (!tf.success || !tf.rates) {
				console.error(`❌ Chunk ${fmt(start)}→${fmt(end)} failed:`, tf.error);
			} else {
				ingestChunk(tf.rates);
			}
			if (i < ranges.length - 1) await new Promise(r => setTimeout(r, 500));
		}

		// Sort, dedupe by day-timestamp, and cap to MAX_SERIES_POINTS.
		for (const [sym, arr] of timeseriesBySymbol) {
			arr.sort((a, b) => a.t - b.t);
			const dedup: SeriesPoint[] = [];
			let prevT = -Infinity;
			for (const p of arr) {
				if (p.t === prevT) dedup[dedup.length - 1] = p;
				else { dedup.push(p); prevT = p.t; }
			}
			if (dedup.length > MAX_SERIES_POINTS) dedup.splice(0, dedup.length - MAX_SERIES_POINTS);
			timeseriesBySymbol.set(sym, dedup);
		}

		const sampleLen = [...timeseriesBySymbol.values()][0]?.length ?? 0;
		console.log(`✅ Historical seed complete — ${sampleLen} points per symbol`);
		seedComplete = true;
		await persistTimeseries().catch(() => {/* non-fatal */});
	} catch (err) {
		console.error('❌ seedHistory failed:', err);
	}
})();

// Serve static demo page from public/
app.use(express.static(path.join(process.cwd(), "public")));

// Serve lightweight-charts library
app.use(
	"/lib/lightweight-charts",
	express.static(path.join(process.cwd(), "node_modules/lightweight-charts/dist"))
);

// Autosave timeseries every 5 min so cold starts don't lose the seeded history.
setInterval(() => {
	persistTimeseries().catch(() => {/* non-fatal */});
}, 5 * 60 * 1000).unref();

// Flush to disk on graceful shutdown.
registerGracefulPersist(() => persistTimeseries());

export { app, ready };

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
if (process.env.NODE_ENV !== "test") {
	app.listen(PORT, () => {
		console.log(`Server listening on http://localhost:${PORT}`);
	});
}


