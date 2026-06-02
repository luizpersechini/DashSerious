import express from "express";
import cors from "cors";
import path from "node:path";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require("../package.json") as {
  version: string;
};
import { MetalpriceClient } from "./metalpriceClient.js";
import { fetchChange } from "./metalpriceClient.js";
import { config } from "./config.js";
import {
  hydrateTimeseries,
  persistTimeseries as persistTS,
  persistJson,
  hydrateJson,
  getStorageStatus,
  registerGracefulPersist,
} from "./storage.js";
import { fetchNews, type NewsItem } from "./newsClient.js";
import {
  fetchAllReferences,
  REFERENCES,
  type ReferenceUnit,
} from "./calibrationClient.js";

type MetalCache = {
  usdPerOunce: number;
  usdPerGram: number;
  usdPerPound?: number;
  usdPerMetricTon?: number;
  usdPerBarrel?: number;
  fxUsdBrl?: number;
  timestamp: number;
};

const app = express();
// CORS (H3): restrict to configured origins. Empty list => same-origin only.
if (config.corsAllowOrigins.length > 0) {
  app.use(cors({ origin: config.corsAllowOrigins, methods: ["GET", "POST"] }));
} else {
  // No cross-origin access; browsers enforce same-origin. Server-to-server
  // (curl, the dashboard itself) is unaffected.
  app.use(cors({ origin: false }));
}

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
const OIL = new Set(["BRENT", "WTI"]);
const FX = new Set(["BRL", "EUR", "CAD"]);

const caches = new Map<string, MetalCache>();
const lastFetchBySymbol = new Map<string, number>();
type SeriesPoint = { t: number; v: number };
const timeseriesBySymbol = new Map<string, SeriesPoint[]>();
const MAX_SERIES_POINTS = 4000; // ~10 years of daily data

type NewsCache = { items: NewsItem[]; fetchedAt: number };
const NEWS_CACHE_TTL_MS = 30 * 60 * 1000;
const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000; // keep articles for 48 h
const NEWS_MAX_ITEMS = 60;
let newsCache: NewsCache | null = null;
let newsInFlight: Promise<NewsItem[]> | null = null;

/** Merge fresh batch into the existing accumulated list (dedup by id, prune >48 h old). */
function mergeNews(
  existing: NewsItem[],
  fresh: NewsItem[],
  now: number,
): NewsItem[] {
  const seenIds = new Set(existing.map((i) => i.id));
  const added = fresh.filter((i) => !seenIds.has(i.id));
  // Secondary dedup by normalised title (catches same article with different URLs)
  const seenTitles = new Set<string>();
  const deduped: NewsItem[] = [];
  for (const item of [...added, ...existing]) {
    if (item.pubMs <= 0 || now - item.pubMs >= NEWS_MAX_AGE_MS) continue;
    const key = item.title.trim().toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    deduped.push(item);
  }
  return deduped.sort((a, b) => b.pubMs - a.pubMs).slice(0, NEWS_MAX_ITEMS);
}

// Single in-flight refresh guard: collapses concurrent /latest cache-miss paths into one upstream call.
// Wraps refreshAllSymbols in a hard timeout via Promise.race because AbortSignal.timeout in undici
// occasionally misses the response stream phase — without this guard a hung fetch wedges the
// singleton forever and every subsequent refresh returns the same dead promise (May 26 observed).
const COALESCE_HARD_TIMEOUT_MS = 30_000;
let inFlightRefresh: Promise<void> | null = null;
function coalesceRefresh(): Promise<void> {
  if (!inFlightRefresh) {
    const work = refreshAllSymbols();
    const guard = new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error("coalesceRefresh hard timeout (30s)")),
        COALESCE_HARD_TIMEOUT_MS,
      ).unref();
    });
    inFlightRefresh = Promise.race([work, guard]).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

// Diagnostic state — surfaced via /health for ops visibility (audit #4).
let lastRefreshAt: number | null = null;
let lastRefreshError: string | null = null;
let nextRefreshAt: number | null = null;
let totalFailedChunks = 0;

// Calibration state — rolling samples of (our metalpriceapi value vs an
// open public reference) per symbol. Persisted to DATA_DIR so the rolling
// window survives restarts (see src/storage.ts). See src/calibrationClient.ts
// for the source registry.
type CalibrationSample = {
  ts: number;
  ourValue: number;
  refValue: number;
  diffPct: number; // (our - ref) / ref × 100
};
const CALIBRATION_HISTORY = 24; // keep last N samples per symbol (~12h at 30min cadence)
const CALIBRATION_FILE = "calibration.json";
const calibrationBySymbol = new Map<string, CalibrationSample[]>();
let lastCalibrationAt: number | null = null;
let lastCalibrationError: string | null = null;

// ── COBALT OVERRIDE (temporary, added 2026-06-02) ───────────────────────────
// metalpriceapi's XCO feed froze at $62,049/ton on 2026-01-09 (143 days flat)
// while the LME/benchmark drifted to ~$56,300. We display the TradingEconomics
// benchmark instead, refreshed each calibration cycle. IMPORTANT: the override
// is applied ONLY to the live XCO timeseries point (what the dashboard charts);
// caches['XCO'].usdPerMetricTon stays the RAW API value so the calibration
// tracker keeps measuring the API's drift/un-freeze. If TradingEconomics goes
// stale (>24h) we fall back to the raw API value so cobalt never blanks.
// To remove this override: delete this block, the cobaltOverride assignment in
// runCalibration, and the XCO branch in the timeseries push.
let cobaltOverride: { value: number; ts: number } | null = null;
const COBALT_OVERRIDE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function cobaltOverrideFresh(): boolean {
  return (
    cobaltOverride !== null &&
    Date.now() - cobaltOverride.ts < COBALT_OVERRIDE_MAX_AGE_MS
  );
}

// Persistence diagnostics — surfaced via /health to confirm whether the GCS
// mount is active and actually being written to.
let storageStatus: {
  dataDir: string;
  configured: boolean;
  writable: boolean;
} | null = null;
let lastPersistAt: number | null = null;

async function persistTimeseries(): Promise<void> {
  await persistTS(timeseriesBySymbol);
  lastPersistAt = Date.now();
}

async function persistCalibration(): Promise<void> {
  await persistJson(CALIBRATION_FILE, {
    version: 1,
    savedAt: Date.now(),
    lastCalibrationAt,
    bySymbol: Object.fromEntries(calibrationBySymbol.entries()),
  });
}

// Readiness: server accepts connections immediately, but /api handlers wait until the first
// refresh resolves (bounded) so we never serve a cold empty cache on first load.
// 30s: must allow the initial fetchLatest's 25s hard-timeout to actually
// complete (success or fail) before letting the seed proceed. With 10s the
// ready timer fires while initial refresh is still pending, the seed starts,
// and the two race for network bandwidth.
const READY_TIMEOUT_MS = 30_000;
const bootStart = Date.now();
let seedComplete = false;
const ready: Promise<void> = (async () => {
  // Probe storage once at boot — confirms whether the GCS mount is present
  // and writable (vs ephemeral tmpfs). Surfaced via /health.
  storageStatus = await getStorageStatus();
  console.log(
    `[storage] dataDir=${storageStatus.dataDir} configured=${storageStatus.configured} writable=${storageStatus.writable}`,
  );
  // Hydrate from disk first so charts aren't empty during the initial fetch window.
  const h = await hydrateTimeseries(timeseriesBySymbol);
  if (h.loaded)
    console.log(`[storage] hydrated ${h.symbols} symbols from disk`);
  // Restore calibration rolling window so the mean-diff numbers accumulate
  // across restarts instead of resetting each deploy.
  const cal = await hydrateJson<{
    lastCalibrationAt: number | null;
    bySymbol: Record<string, CalibrationSample[]>;
  }>(CALIBRATION_FILE);
  if (cal?.bySymbol) {
    for (const [sym, arr] of Object.entries(cal.bySymbol)) {
      if (Array.isArray(arr))
        calibrationBySymbol.set(sym, arr.slice(-CALIBRATION_HISTORY));
    }
    lastCalibrationAt = cal.lastCalibrationAt ?? null;
    console.log(
      `[storage] hydrated calibration for ${calibrationBySymbol.size} symbols`,
    );
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, READY_TIMEOUT_MS);
    coalesceRefresh()
      .then(() => {
        lastRefreshAt = Date.now();
        lastRefreshError = null;
      })
      .catch((err: any) => {
        // Boot anyway; /api gate will 503 until cache is warm.
        lastRefreshError = err?.message ?? String(err);
        console.error(
          JSON.stringify({
            severity: "ERROR",
            component: "initial_refresh",
            error: lastRefreshError,
          }),
        );
      })
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
    throw new Error(
      `Failed to fetch ${symbol}: ${resp.error?.code} ${resp.error?.info}`,
    );
  }
  const unitsPerUsd = resp.rates[symbol]; // how many units of symbol per 1 USD

  if (FX.has(symbol)) {
    const base: MetalCache = {
      usdPerOunce: 0,
      usdPerGram: 0,
      fxUsdBrl: unitsPerUsd,
      timestamp: now,
    };
    caches.set(symbol, base);
    lastFetchBySymbol.set(symbol, now);
    return;
  }
  if (OIL.has(symbol)) {
    const base: MetalCache = {
      usdPerOunce: 0,
      usdPerGram: 0,
      usdPerBarrel: 1 / unitsPerUsd,
      timestamp: now,
    };
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
    throw new Error(
      `Failed multi fetch: ${resp.error?.code} ${resp.error?.info}`,
    );
  }
  for (const symbol of symbols) {
    const rate = resp.rates[symbol as keyof typeof resp.rates];
    if (rate == null) continue;
    const unitsPerUsd = rate;
    if (FX.has(symbol)) {
      const base: MetalCache = {
        usdPerOunce: 0,
        usdPerGram: 0,
        fxUsdBrl: unitsPerUsd,
        timestamp: now,
      };
      caches.set(symbol, base);
      lastFetchBySymbol.set(symbol, now);
      const arr = timeseriesBySymbol.get(symbol) ?? [];
      const lastPoint = arr[arr.length - 1];
      if (!lastPoint || now - lastPoint.t > 60 * 1000) {
        arr.push({ t: now, v: unitsPerUsd });
        if (arr.length > MAX_SERIES_POINTS)
          arr.splice(0, arr.length - MAX_SERIES_POINTS);
        timeseriesBySymbol.set(symbol, arr);
      }
      continue;
    }
    if (OIL.has(symbol)) {
      const usdPerBarrel = 1 / unitsPerUsd;
      const base: MetalCache = {
        usdPerOunce: 0,
        usdPerGram: 0,
        usdPerBarrel,
        timestamp: now,
      };
      caches.set(symbol, base);
      lastFetchBySymbol.set(symbol, now);
      const arr = timeseriesBySymbol.get(symbol) ?? [];
      const lastPoint = arr[arr.length - 1];
      if (!lastPoint || now - lastPoint.t > 60 * 1000) {
        arr.push({ t: now, v: usdPerBarrel });
        if (arr.length > MAX_SERIES_POINTS)
          arr.splice(0, arr.length - MAX_SERIES_POINTS);
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

    // Record a display-value time series point. For XCO, substitute the cobalt
    // override (TradingEconomics benchmark) when fresh — cache stays RAW above
    // so calibration keeps tracking the API's staleness. See COBALT OVERRIDE.
    let display = getDisplayValue(symbol, base);
    if (symbol === "XCO" && cobaltOverrideFresh()) {
      display = cobaltOverride!.value;
    }
    const arr = timeseriesBySymbol.get(symbol) ?? [];
    const lastPoint = arr[arr.length - 1];
    if (!lastPoint || now - lastPoint.t > 60 * 1000) {
      arr.push({ t: now, v: display });
      if (arr.length > MAX_SERIES_POINTS)
        arr.splice(0, arr.length - MAX_SERIES_POINTS);
      timeseriesBySymbol.set(symbol, arr);
    }
  }
}

function getDisplayValue(symbol: string, cache: MetalCache): number {
  if (symbol === "XCU" || symbol === "NI") return cache.usdPerPound ?? 0;
  if (symbol === "XCO") return cache.usdPerMetricTon ?? 0;
  if (FX.has(symbol)) return cache.fxUsdBrl ?? 0;
  if (OIL.has(symbol)) return cache.usdPerBarrel ?? 0;
  return cache.usdPerOunce;
}

/**
 * Returns our price for `symbol` in the requested unit, or null if we don't
 * have a comparable value. Used by the calibration tracker to compare apples
 * to apples against external references.
 */
function getValueInUnit(
  symbol: string,
  cache: MetalCache,
  unit: ReferenceUnit,
): number | null {
  // Avdp pound → metric ton conversion factor.
  const LB_PER_MT = 2204.623;
  if (unit === "USD/lb") {
    if (cache.usdPerPound != null) return cache.usdPerPound;
    // Fallback for XCO (we store usdPerMetricTon natively).
    if (cache.usdPerMetricTon != null) return cache.usdPerMetricTon / LB_PER_MT;
    return null;
  }
  if (unit === "USD/oz") return cache.usdPerOunce ?? null;
  if (unit === "USD/ton") {
    if (cache.usdPerMetricTon != null) return cache.usdPerMetricTon;
    // NI cache only carries usdPerPound — convert.
    if (cache.usdPerPound != null) return cache.usdPerPound * LB_PER_MT;
    return null;
  }
  if (unit === "USD/bbl") return cache.usdPerBarrel ?? null;
  return null;
}

async function handleLatest(
  symbol: string,
  req: express.Request,
  res: express.Response,
) {
  try {
    // Serve cache; if too old, coalesce all waiters onto a single multi-symbol refresh
    // so first-load never fans out into 8 concurrent single-symbol upstream calls.
    const last = lastFetchBySymbol.get(symbol) ?? 0;
    if (!caches.has(symbol) || Date.now() - last > REFRESH_INTERVAL_MS) {
      await coalesceRefresh();
    }
    const data = caches.get(symbol);
    if (!data)
      return res.status(503).json({ success: false, error: "no data" });
    // Weak ETag derived from the cache timestamp — cheap and exact.
    const etag = `W/"${symbol}-${data.timestamp}"`;
    res.setHeader("Cache-Control", "public, max-age=30");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    return res.json({ success: true, data });
  } catch (err: any) {
    return res
      .status(502)
      .json({ success: false, error: String(err?.message || err) });
  }
}

function handleTimeseries(
  symbol: string,
  req: express.Request,
  res: express.Response,
) {
  res.setHeader("Cache-Control", "no-store");
  const series = timeseriesBySymbol.get(symbol) ?? [];
  const sinceTs = Number(req.query?.since_ts ?? 0);
  let points: SeriesPoint[];
  if (Number.isFinite(sinceTs) && sinceTs > 0) {
    points = series.filter((p) => p.t >= sinceTs);
  } else {
    const limitParam = Number((req.query?.limit as string) ?? "100");
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, MAX_SERIES_POINTS)
        : 100;
    points = series.slice(-limit);
  }
  return res.json({
    success: true,
    data: { points, seedPending: !seedComplete },
  });
}

async function handleChange(
  symbol: string,
  req: express.Request,
  res: express.Response,
) {
  try {
    const date_type = (req.query?.date_type as string) || "month";
    const r = await fetchChange({
      date_type: date_type as any,
      base: "USD",
      currencies: [symbol],
    });
    return res.json(r);
  } catch (e: any) {
    return res
      .status(500)
      .json({ success: false, error: String(e?.message || e) });
  }
}

function routeFor(symbol: string, name: string) {
  app.get(`/api/${name}/latest`, (req, res) => handleLatest(symbol, req, res));
  app.get(`/api/${name}/timeseries`, (req, res) =>
    handleTimeseries(symbol, req, res),
  );
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
  ["BRENT", "brent"],
  ["WTI", "wti"],
  ["EUR", "eur"],
  ["CAD", "cad"],
];

const NAME_TO_SYMBOL = new Map<string, string>(TRACKED.map(([s, n]) => [n, s]));

// Readiness gate (audit #7): wait for the bounded `ready` promise, then only
// 503 if we have NO data at all (cache empty AND timeseries empty). If we
// have historical data, serve it even with a cold live cache — stale prices
// are better than blank charts. Specific symbol routes can still surface
// staleness via their own checks.
app.use("/api", async (_req, res, next) => {
  try {
    await ready;
  } catch {
    /* swallowed below by data check */
  }
  if (caches.size === 0 && timeseriesBySymbol.size === 0) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({
      success: false,
      error: "Cache warming up",
      retryAfterMs: 5000,
    });
  }
  next();
});

// Parameterized routes (Phase 4a). The per-name aliases below remain for backward compatibility.
app.get("/api/metal/:name/latest", (req, res) => {
  const symbol = NAME_TO_SYMBOL.get(
    String(req.params.name || "").toLowerCase(),
  );
  if (!symbol)
    return res.status(404).json({ success: false, error: "unknown metal" });
  return handleLatest(symbol, req, res);
});
app.get("/api/metal/:name/timeseries", (req, res) => {
  const symbol = NAME_TO_SYMBOL.get(
    String(req.params.name || "").toLowerCase(),
  );
  if (!symbol)
    return res.status(404).json({ success: false, error: "unknown metal" });
  return handleTimeseries(symbol, req, res);
});
app.get("/api/metal/:name/change", (req, res) => {
  const symbol = NAME_TO_SYMBOL.get(
    String(req.params.name || "").toLowerCase(),
  );
  if (!symbol)
    return res.status(404).json({ success: false, error: "unknown metal" });
  return handleChange(symbol, req, res);
});

for (const [sym, name] of TRACKED) routeFor(sym, name);

// Aggregated timeseries: returns all tracked symbols in one response.
// Format: { success: true, symbols: { XAU: [{t,v},...], ... } }
app.get("/api/allmetals/timeseries", (req, res) => {
  const limitParam = Number((req.query?.limit as string) ?? "0");
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_SERIES_POINTS)
      : 0;
  const symbols: Record<string, SeriesPoint[]> = {};
  for (const [sym] of TRACKED) {
    const arr = timeseriesBySymbol.get(sym) ?? [];
    symbols[sym] = limit > 0 ? arr.slice(-limit) : arr.slice();
  }
  return res.json({ success: true, symbols });
});

// Health: unblocked (not under /api), usable as a Cloud Run readiness probe.
app.get("/api/version", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.json({ version: APP_VERSION });
});

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  // Compute oldest/newest data points across all symbols for chart-depth visibility.
  let oldestPoint = Infinity;
  let newestPoint = -Infinity;
  for (const arr of timeseriesBySymbol.values()) {
    if (arr.length === 0) continue;
    if (arr[0]!.t < oldestPoint) oldestPoint = arr[0]!.t;
    if (arr[arr.length - 1]!.t > newestPoint)
      newestPoint = arr[arr.length - 1]!.t;
  }
  return res.json({
    ok: true,
    cacheWarm: caches.size === TRACKED.length,
    cachedSymbols: caches.size,
    seedComplete,
    uptimeMs: Date.now() - bootStart,
    // Diagnostics (audit #4)
    refresh: {
      intervalMs: REFRESH_INTERVAL_MS,
      lastRefreshAt: lastRefreshAt
        ? new Date(lastRefreshAt).toISOString()
        : null,
      lastRefreshError,
      nextRefreshAt: nextRefreshAt
        ? new Date(nextRefreshAt).toISOString()
        : null,
      msSinceLastSuccess: lastRefreshAt ? Date.now() - lastRefreshAt : null,
    },
    data: {
      totalFailedChunks,
      oldestPoint:
        oldestPoint === Infinity ? null : new Date(oldestPoint).toISOString(),
      newestPoint:
        newestPoint === -Infinity ? null : new Date(newestPoint).toISOString(),
    },
    persistence: {
      // mode: "gcs" once DATA_BUCKET is provisioned (DATA_DIR set + writable),
      // "ephemeral" otherwise. lastPersistAt confirms writes are landing.
      mode:
        storageStatus?.configured && storageStatus?.writable
          ? "gcs"
          : "ephemeral",
      dataDir: storageStatus?.dataDir ?? null,
      configured: storageStatus?.configured ?? null,
      writable: storageStatus?.writable ?? null,
      lastPersistAt: lastPersistAt
        ? new Date(lastPersistAt).toISOString()
        : null,
    },
    calibration: (() => {
      const out: Record<
        string,
        {
          source: string;
          unit: string;
          samples: number;
          latest: CalibrationSample | null;
          meanDiffPct: number | null;
        }
      > = {};
      for (const ref of REFERENCES) {
        const arr = calibrationBySymbol.get(ref.symbol) ?? [];
        const latest = arr.length > 0 ? arr[arr.length - 1]! : null;
        const mean =
          arr.length > 0
            ? arr.reduce((a, b) => a + b.diffPct, 0) / arr.length
            : null;
        out[ref.symbol] = {
          source: ref.source,
          unit: ref.unit,
          samples: arr.length,
          latest,
          meanDiffPct: mean,
        };
      }
      return {
        lastSampleAt: lastCalibrationAt
          ? new Date(lastCalibrationAt).toISOString()
          : null,
        lastError: lastCalibrationError,
        intervalMs: 30 * 60 * 1000,
        bySymbol: out,
      };
    })(),
    cobaltOverride: {
      // Temporary: cobalt displayed from the TradingEconomics benchmark because
      // metalpriceapi's XCO froze on 2026-01-09. rawApiValue tracks the (stale)
      // API value; active=false means we've fallen back to it (override stale).
      active: cobaltOverrideFresh(),
      source: "tradingeconomics",
      overrideValue: cobaltOverride?.value ?? null,
      overrideAgeMin: cobaltOverride
        ? Math.round((Date.now() - cobaltOverride.ts) / 60000)
        : null,
      rawApiValue: caches.get("XCO")?.usdPerMetricTon ?? null,
    },
  });
});

// Manual refresh endpoint (forces immediate cache clear and refetch)
// H1: gated behind REFRESH_TOKEN shared secret to prevent anonymous
// quota-burn DoS against the MetalpriceAPI key. Send the token via the
// `x-refresh-token` header. If REFRESH_TOKEN is unset, the endpoint stays
// open (back-compat) — a warning is logged at startup in that case.
app.post("/api/refresh", async (req, res) => {
  if (config.refreshToken) {
    const presented = req.header("x-refresh-token");
    if (presented !== config.refreshToken) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid or missing x-refresh-token" });
    }
  }
  try {
    // Clear all caches to force fresh data
    caches.clear();
    lastFetchBySymbol.clear();

    // Fetch all symbols immediately
    await refreshAllSymbols();

    return res.json({ success: true, message: "Data refreshed successfully" });
  } catch (err: any) {
    // Don't leak internal error detail to the client (could include the
    // API key embedded in an upstream URL). Log server-side, return generic.
    console.error("[/api/refresh] error:", err);
    return res.status(500).json({
      success: false,
      error: "refresh failed",
    });
  }
});

app.get("/api/news", async (_req, res) => {
  const configured = !!config.newsApiKey;
  try {
    const now = Date.now();
    if (newsCache && now - newsCache.fetchedAt < NEWS_CACHE_TTL_MS)
      return res.json({ items: newsCache.items, configured });

    if (!newsInFlight) {
      newsInFlight = fetchNews(config.newsApiKey).finally(() => {
        newsInFlight = null;
      });
    }
    const fresh = await newsInFlight;
    const now2 = Date.now();
    const merged = mergeNews(newsCache?.items ?? [], fresh, now2);
    newsCache = { items: merged, fetchedAt: now2 };
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.json({ items: merged, configured });
  } catch (err: any) {
    if (newsCache)
      return res.json({ items: newsCache.items, configured, stale: true });
    return res
      .status(502)
      .json({ items: [], configured, error: String(err?.message ?? err) });
  }
});

// Periodic refresh with retry/backoff (audit #3).
// Replaces a bare setInterval: on failure, schedules a fast retry (1 min)
// instead of waiting the full REFRESH_INTERVAL_MS cycle. Structured logging
// to Cloud Logging via stderr.
// 15s: when a refresh fails, recover fast. We've observed on-demand fetch
// succeed within 1s right after a scheduled one timed out — the failure
// is transient, so a quick retry usually wins. Old value (60s) left the
// system stale for a full minute after each transient blip.
const RETRY_INTERVAL_MS = 15 * 1000;
function scheduleNextRefresh(delayMs: number): void {
  nextRefreshAt = Date.now() + delayMs;
  setTimeout(async () => {
    try {
      await coalesceRefresh();
      lastRefreshAt = Date.now();
      lastRefreshError = null;
      scheduleNextRefresh(REFRESH_INTERVAL_MS);
    } catch (err: any) {
      lastRefreshError = err?.message ?? String(err);
      console.error(
        JSON.stringify({
          severity: "ERROR",
          component: "periodic_refresh",
          error: lastRefreshError,
          nextAttemptInMs: RETRY_INTERVAL_MS,
        }),
      );
      scheduleNextRefresh(RETRY_INTERVAL_MS);
    }
  }, delayMs).unref();
}
// Kick off the loop. First call happens after REFRESH_INTERVAL_MS — the
// initial refresh on boot is handled by the `ready` promise above.
scheduleNextRefresh(REFRESH_INTERVAL_MS);

// ── Calibration scheduler ───────────────────────────────────────────────────
// Periodically samples open public references (Stooq CSV, Investing.com scrape)
// and records the diff vs our metalpriceapi values. Surfaces rolling diff on
// /health so drift between providers is measurable instead of guessed.
const CALIBRATION_INTERVAL_MS = 30 * 60 * 1000; // 30 min — references update daily-ish

async function runCalibration(): Promise<void> {
  const now = Date.now();
  const refs = await fetchAllReferences();
  for (const ref of REFERENCES) {
    const refData = refs[ref.symbol];
    if (!refData || refData.value == null) continue;
    // Cobalt override: use the freshly-fetched TradingEconomics benchmark as
    // the displayed XCO value (the API feed is stale). Set before the cache
    // check so it updates even on cycles where the XCO cache isn't ready.
    if (ref.symbol === "XCO") {
      cobaltOverride = { value: refData.value, ts: now };
    }
    const cache = caches.get(ref.symbol);
    if (!cache) continue;
    const ourValue = getValueInUnit(ref.symbol, cache, ref.unit);
    if (ourValue == null || ourValue === 0) continue;
    const diffPct = ((ourValue - refData.value) / refData.value) * 100;
    const sample: CalibrationSample = {
      ts: now,
      ourValue,
      refValue: refData.value,
      diffPct,
    };
    const arr = calibrationBySymbol.get(ref.symbol) ?? [];
    arr.push(sample);
    if (arr.length > CALIBRATION_HISTORY) arr.shift();
    calibrationBySymbol.set(ref.symbol, arr);
  }
  lastCalibrationAt = now;
  lastCalibrationError = null;
  await persistCalibration().catch(() => {
    /* non-fatal */
  });
}

function scheduleNextCalibration(delayMs: number): void {
  setTimeout(async () => {
    try {
      await runCalibration();
    } catch (err: any) {
      lastCalibrationError = err?.message ?? String(err);
      console.error(
        JSON.stringify({
          severity: "WARNING",
          component: "calibration",
          error: lastCalibrationError,
        }),
      );
    }
    scheduleNextCalibration(CALIBRATION_INTERVAL_MS);
  }, delayMs).unref();
}
// First calibration fires 30s after boot so live cache has time to warm.
// After that, runs every CALIBRATION_INTERVAL_MS.
scheduleNextCalibration(30 * 1000);

// Seed timeseries with historical data on startup. Fetches only missing date ranges
// (backfill + top-up) to avoid re-hitting the API for data already on disk.
(async function seedHistory() {
  // Wait for the initial refresh to settle before hammering the API with the
  // seed. Without this, both run concurrently at module load and the seed
  // can starve the live refresh of bandwidth on Cloud Run — observed
  // 2026-05-26 as a 25s hard-timeout on fetchLatest while the seed was
  // running 5 concurrent timeframe chunks. `ready` resolves after the
  // initial refresh OR the 10s grace, whichever comes first.
  await ready.catch(() => {
    /* boot anyway */
  });
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

    // Always fetch the full historical range. The previous hasData/backfill+
    // topup logic had an edge case: if `await ready` had added a live intraday
    // point before the seed ran, oldestMs/newestMs reflected that single
    // live point (today), so the topup branch decided no new data was needed.
    // The backfill chunks were generated but somehow the most-recent chunk
    // silently didn't ingest (observed 2026-05-27: 4yr loaded, last year
    // missing, failedChunks=0).
    //
    // Simpler is more robust: always request the full window, let the dedupe
    // below collapse duplicates. Cost is one extra API call per chunk on warm
    // restarts (currently irrelevant — Cloud Run has no persistent disk).
    const ranges: [Date, Date][] = [];
    function pushChunks(from: Date, to: Date) {
      let cur = new Date(from);
      while (cur <= to) {
        const end = new Date(
          Math.min(cur.getTime() + (CHUNK_DAYS - 1) * DAY_MS, to.getTime()),
        );
        ranges.push([new Date(cur), end]);
        cur = new Date(end.getTime() + DAY_MS);
      }
    }
    pushChunks(targetStart, yesterday);
    ranges.reverse(); // newest first — user-visible recent range fills in fastest

    if (ranges.length === 0) {
      console.log(
        `📊 Historical data already up to date (${[...timeseriesBySymbol.values()][0]?.length ?? 0} points)`,
      );
      seedComplete = true;
      return;
    }

    console.log(
      `📊 Fetching ${ranges.length} chunk(s) covering up to ${SEED_DEPTH_DAYS} days of history...`,
    );

    function ingestChunk(rates: Record<string, Record<string, number>>) {
      for (const date of Object.keys(rates).sort()) {
        const dayRates = rates[date]!;
        const t = new Date(date).getTime();
        for (const symbol of symbols) {
          const unitsPerUsd = dayRates[symbol as keyof typeof dayRates];
          if (unitsPerUsd == null) continue;
          let v: number;
          if (FX.has(symbol)) {
            v = unitsPerUsd;
          } else if (OIL.has(symbol)) {
            v = 1 / unitsPerUsd; // USD per barrel
          } else {
            const usdPerOunce = 1 / unitsPerUsd;
            const gramsPerOunce = PRECIOUS.has(symbol)
              ? TROY_OUNCE_GRAMS
              : OUNCE_GRAMS;
            const usdPerGram = usdPerOunce / gramsPerOunce;
            const base: MetalCache = { usdPerOunce, usdPerGram, timestamp: t };
            if (symbol === "XCU" || symbol === "NI")
              base.usdPerPound = usdPerGram * POUND_GRAMS;
            if (symbol === "XCO")
              base.usdPerMetricTon = usdPerGram * METRIC_TON_GRAMS;
            v = getDisplayValue(symbol, base);
          }
          const arr = timeseriesBySymbol.get(symbol) ?? [];
          arr.push({ t, v });
          timeseriesBySymbol.set(symbol, arr);
        }
      }
    }

    // Per-chunk try/catch: a single failing chunk (timeout, !res.ok, network
    // error) must NOT kill the entire seed. Without this, fetchTimeframe
    // throwing on any chunk propagates to the outer catch and leaves
    // seedComplete=false with zero historical data. Hit by audit finding #6
    // and root cause of the May 26 second-deploy outage.
    let failedChunks = 0;
    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i]!;
      try {
        const tf = await client.fetchTimeframe({
          start_date: fmt(start),
          end_date: fmt(end),
          base: "USD",
          currencies: symbols,
        });
        if (!tf.success || !tf.rates) {
          failedChunks++;
          console.error(
            JSON.stringify({
              severity: "ERROR",
              component: "seed_chunk",
              outcome: "api_error",
              start: fmt(start),
              end: fmt(end),
              error: tf.error,
            }),
          );
        } else {
          // Count point insertions for visibility: a success response with
          // empty rates would silently no-op without this. Treats that case
          // as a failure too so /health.totalFailedChunks reflects reality.
          const before = symbols
            .map((s) => timeseriesBySymbol.get(s)?.length ?? 0)
            .reduce((a, b) => a + b, 0);
          ingestChunk(tf.rates);
          const after = symbols
            .map((s) => timeseriesBySymbol.get(s)?.length ?? 0)
            .reduce((a, b) => a + b, 0);
          const inserted = after - before;
          if (inserted === 0) {
            failedChunks++;
            console.warn(
              JSON.stringify({
                severity: "WARNING",
                component: "seed_chunk",
                outcome: "empty_rates",
                start: fmt(start),
                end: fmt(end),
                rateKeys: Object.keys(tf.rates).length,
              }),
            );
          }
        }
      } catch (e: any) {
        failedChunks++;
        console.error(
          JSON.stringify({
            severity: "ERROR",
            component: "seed_chunk",
            outcome: "thrown",
            start: fmt(start),
            end: fmt(end),
            error: e?.message ?? String(e),
          }),
        );
      }
      if (i < ranges.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    totalFailedChunks += failedChunks;
    if (failedChunks > 0) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          component: "seed",
          failedChunks,
          totalChunks: ranges.length,
          message: "Seed completed with gaps",
        }),
      );
    }

    // Sort, dedupe by day-timestamp, and cap to MAX_SERIES_POINTS.
    for (const [sym, arr] of timeseriesBySymbol) {
      arr.sort((a, b) => a.t - b.t);
      const dedup: SeriesPoint[] = [];
      let prevT = -Infinity;
      for (const p of arr) {
        if (p.t === prevT) dedup[dedup.length - 1] = p;
        else {
          dedup.push(p);
          prevT = p.t;
        }
      }
      if (dedup.length > MAX_SERIES_POINTS)
        dedup.splice(0, dedup.length - MAX_SERIES_POINTS);
      timeseriesBySymbol.set(sym, dedup);
    }

    const sampleLen = [...timeseriesBySymbol.values()][0]?.length ?? 0;
    console.log(`✅ Historical seed complete — ${sampleLen} points per symbol`);
    seedComplete = true;
    await persistTimeseries().catch(() => {
      /* non-fatal */
    });
  } catch (err) {
    console.error("❌ seedHistory failed:", err);
    // Audit finding #12: flip the flag even on failure so the frontend's
    // seedPending UI doesn't stay true forever.
    seedComplete = true;
  }
})();

// Serve static demo page from public/
app.use(express.static(path.join(process.cwd(), "public")));

// Serve lightweight-charts library
app.use(
  "/lib/lightweight-charts",
  express.static(
    path.join(process.cwd(), "node_modules/lightweight-charts/dist"),
  ),
);

// Autosave timeseries every 5 min so cold starts don't lose the seeded history.
setInterval(
  () => {
    persistTimeseries().catch(() => {
      /* non-fatal */
    });
  },
  5 * 60 * 1000,
).unref();

// Flush to disk on graceful shutdown — both timeseries and calibration.
registerGracefulPersist(async () => {
  await Promise.allSettled([persistTimeseries(), persistCalibration()]);
});

export { app, ready };

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
if (process.env.NODE_ENV !== "test") {
  if (!config.refreshToken) {
    console.warn(
      "[security] REFRESH_TOKEN not set — POST /api/refresh is unauthenticated. " +
        "Set REFRESH_TOKEN in .env to require the x-refresh-token header.",
    );
  }
  if (config.corsAllowOrigins.length === 0) {
    console.warn(
      "[security] CORS_ALLOW_ORIGINS not set — cross-origin requests are blocked (same-origin only).",
    );
  }
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}
