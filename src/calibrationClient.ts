/**
 * Calibration client — periodically samples reference prices from open public
 * sources (Stooq CSV, Investing.com HTML scrape) and compares them against
 * metalpriceapi values. Used to detect whether metalpriceapi is drifting
 * relative to standard market references.
 *
 * Does NOT modify displayed prices. Surfaces the rolling diff via /health so
 * any future calibration adjustment can be data-driven instead of a guess.
 *
 * Added 2026-05-28 after discovering the historical -0.15/lb "correction" on
 * copper and nickel was pushing prices AWAY from the real market (~0.1% match
 * without it). See qa/KNOWN-BUGS.md.
 */

export type ReferenceUnit = "USD/lb" | "USD/oz" | "USD/ton" | "USD/bbl";

export type ReferenceSource = {
  /** Our internal symbol (matches src/server.ts TRACKED) */
  symbol: string;
  /** Human-readable */
  name: string;
  /** Public URL of the reference */
  url: string;
  /** Source label for diagnostics */
  source: "stooq" | "investing.com";
  /** Unit of the returned numeric value */
  unit: ReferenceUnit;
  /** Parser: takes the raw response body, returns the price in `unit` or null */
  parse: (body: string) => number | null;
};

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Stooq CSV: "SYMBOL,DATE,TIME,CLOSE" — second-line value. Returns numeric close. */
function parseStooqCsv(body: string): number | null {
  const lines = body.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const fields = lines[1]!.split(",");
  const close = parseFloat(fields[fields.length - 1] ?? "");
  if (!Number.isFinite(close)) return null;
  return close;
}

/** Stooq CSV where the value is in cents (HG.F, SI.F). Divides by 100. */
function parseStooqCents(body: string): number | null {
  const v = parseStooqCsv(body);
  return v == null ? null : v / 100;
}

/** Investing.com HTML: extracts `data-test="instrument-price-last">N,NNN.NN`. */
function parseInvestingPriceLast(body: string): number | null {
  const m = body.match(/data-test="instrument-price-last"[^>]*>([0-9.,]+)/);
  if (!m) return null;
  const cleaned = (m[1] ?? "").replace(/,/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ── Source registry ─────────────────────────────────────────────────────────
//
// Each entry pairs an internal symbol with an open public reference.
// Symbols not listed here are simply not tracked (e.g., XCO has no good free
// reference, BRL/EUR/CAD are FX and not the target of this calibration).

export const REFERENCES: ReferenceSource[] = [
  {
    symbol: "XCU",
    name: "Copper (COMEX HG futures)",
    url: "https://stooq.com/q/l/?s=hg.f&f=sd2t2c&h&e=csv",
    source: "stooq",
    unit: "USD/lb",
    parse: parseStooqCents,
  },
  {
    symbol: "NI",
    name: "Nickel (LME 3-month, Investing.com)",
    url: "https://www.investing.com/commodities/nickel",
    source: "investing.com",
    unit: "USD/ton",
    parse: parseInvestingPriceLast,
  },
  {
    symbol: "XAU",
    name: "Gold (COMEX GC futures)",
    url: "https://stooq.com/q/l/?s=gc.f&f=sd2t2c&h&e=csv",
    source: "stooq",
    unit: "USD/oz",
    parse: parseStooqCsv,
  },
  {
    symbol: "XAG",
    name: "Silver (COMEX SI futures)",
    url: "https://stooq.com/q/l/?s=si.f&f=sd2t2c&h&e=csv",
    source: "stooq",
    unit: "USD/oz",
    parse: parseStooqCents,
  },
  {
    symbol: "XPT",
    name: "Platinum (NYMEX PL futures)",
    url: "https://stooq.com/q/l/?s=pl.f&f=sd2t2c&h&e=csv",
    source: "stooq",
    unit: "USD/oz",
    parse: parseStooqCsv,
  },
  {
    symbol: "XPD",
    name: "Palladium (NYMEX PA futures)",
    url: "https://stooq.com/q/l/?s=pa.f&f=sd2t2c&h&e=csv",
    source: "stooq",
    unit: "USD/oz",
    parse: parseStooqCsv,
  },
  {
    symbol: "WTI",
    name: "WTI Crude (NYMEX CL futures)",
    url: "https://stooq.com/q/l/?s=cl.f&f=sd2t2c&h&e=csv",
    source: "stooq",
    unit: "USD/bbl",
    parse: parseStooqCsv,
  },
];

// ── Fetch ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function fetchReference(
  ref: ReferenceSource,
): Promise<number | null> {
  try {
    const res = await fetch(ref.url, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return ref.parse(body);
  } catch {
    return null;
  }
}

export async function fetchAllReferences(): Promise<
  Record<string, { value: number | null; unit: ReferenceUnit; source: string }>
> {
  const entries = await Promise.all(
    REFERENCES.map(async (ref) => {
      const value = await fetchReference(ref);
      return [
        ref.symbol,
        { value, unit: ref.unit, source: ref.source },
      ] as const;
    }),
  );
  const out: Record<
    string,
    { value: number | null; unit: ReferenceUnit; source: string }
  > = {};
  for (const [sym, data] of entries) out[sym] = data;
  return out;
}
