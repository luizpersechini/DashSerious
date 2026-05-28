import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";

// Config loads .env; this mirrors that so the API-key check below is accurate.
await import("../src/config.js");
const hasApiKey = !!process.env.METALPRICE_API_KEY;

// All 12 tracked symbols. If you add a new one in src/server.ts TRACKED,
// also add the route name + symbol mapping here so the smoke tests cover it.
const METALS = [
  "gold",
  "silver",
  "platinum",
  "palladium",
  "copper",
  "nickel",
  "cobalt",
  "brl",
  "eur",
  "cad",
  "brent",
  "wti",
];

const ROUTE_TO_SYMBOL: Record<string, string> = {
  gold: "XAU",
  silver: "XAG",
  platinum: "XPT",
  palladium: "XPD",
  copper: "XCU",
  nickel: "NI",
  cobalt: "XCO",
  brl: "BRL",
  eur: "EUR",
  cad: "CAD",
  brent: "BRENT",
  wti: "WTI",
};

// MetalpriceClient's constructor throws without a key, so we only import the server when
// an API key is available. Without a key, the whole suite is skipped.
const serverMod = hasApiKey ? await import("../src/server.js") : null;
const app = serverMod?.app;
const ready = serverMod?.ready;

describe.skipIf(!hasApiKey)("smoke: server surface", () => {
  beforeAll(async () => {
    // Await the readiness gate — bounded internally — so the first request isn't racing the cache.
    await ready;
  }, 15_000);

  it("GET /health returns ok:true", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.uptimeMs).toBe("number");
  });

  it.skipIf(!hasApiKey)(
    "GET /api/metal/gold/latest returns structured data",
    async () => {
      const res = await request(app).get("/api/metal/gold/latest");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.usdPerOunce).toBe("number");
      expect(res.headers["cache-control"]).toMatch(/max-age/);
      expect(res.headers.etag).toBeDefined();
    },
  );

  it.skipIf(!hasApiKey)(
    "all 12 /latest endpoints (aliases + parameterized) respond with success",
    async () => {
      for (const m of METALS) {
        const alias = await request(app).get(`/api/${m}/latest`);
        const param = await request(app).get(`/api/metal/${m}/latest`);
        expect(alias.status, `alias ${m}`).toBe(200);
        expect(alias.body.success, `alias ${m}`).toBe(true);
        expect(param.status, `param ${m}`).toBe(200);
        expect(param.body.success, `param ${m}`).toBe(true);
      }
    },
    30_000,
  );

  it.skipIf(!hasApiKey)(
    "GET /api/allmetals/timeseries returns all 12 symbols (the frontend's primary fetch)",
    async () => {
      const res = await request(app).get("/api/allmetals/timeseries?limit=2");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      for (const m of METALS) {
        const symKey = ROUTE_TO_SYMBOL[m];
        expect(
          Array.isArray(res.body.symbols[symKey]),
          `missing symbol ${symKey}`,
        ).toBe(true);
      }
    },
  );

  it.skipIf(!hasApiKey)(
    "/health exposes the new diagnostic fields (regression: ensures observability shape)",
    async () => {
      const res = await request(app).get("/health");
      expect(res.body).toHaveProperty("refresh");
      expect(res.body.refresh).toHaveProperty("intervalMs");
      expect(res.body.refresh).toHaveProperty("lastRefreshAt");
      expect(res.body.refresh).toHaveProperty("lastRefreshError");
      expect(res.body.refresh).toHaveProperty("nextRefreshAt");
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveProperty("totalFailedChunks");
      expect(res.body.data).toHaveProperty("oldestPoint");
      expect(res.body.data).toHaveProperty("newestPoint");
    },
  );

  it("frontend index.html bundles the polling fix (regression: 2026-05-27)", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    // The useEffect must register a periodic refresh interval. If anyone
    // reverts to a single-shot fetch, this assertion fails — same bug as
    // qa/KNOWN-BUGS.md "Frontend never re-fetches".
    expect(res.text).toMatch(/setInterval\s*\(\s*refresh/);
    expect(res.text).toMatch(/visibilitychange/);
  });

  it("frontend bundles the chart timeframe filter fix (regression: slice(-N) bug)", async () => {
    const res = await request(app).get("/");
    // After the 2026-05-27 fix, getPoints() must filter by ms time-window
    // (cutoff math) instead of array slice(-days). The downsample-by-UTC-day
    // for windows >= 30d must also be present.
    expect(res.text).toMatch(/days \* 86_400_000|days \* 86400000/);
    expect(res.text).toMatch(/byDay|UTC day/);
  });

  it("GET /api/metal/unknown/latest returns 404", async () => {
    const res = await request(app).get("/api/metal/doesnotexist/latest");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("ETag 304 handshake works", async () => {
    if (!hasApiKey) return; // cache warm required
    const first = await request(app).get("/api/gold/latest");
    if (first.status !== 200 || !first.headers.etag) return;
    const second = await request(app)
      .get("/api/gold/latest")
      .set("If-None-Match", first.headers.etag);
    expect(second.status).toBe(304);
  });
});
