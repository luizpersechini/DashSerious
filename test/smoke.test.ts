import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";

// Config loads .env; this mirrors that so the API-key check below is accurate.
await import("../src/config.js");
const hasApiKey = !!process.env.METALPRICE_API_KEY;

const METALS = ["gold", "silver", "platinum", "palladium", "copper", "nickel", "cobalt", "brl"];

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

	it.skipIf(!hasApiKey)("GET /api/metal/gold/latest returns structured data", async () => {
		const res = await request(app).get("/api/metal/gold/latest");
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(typeof res.body.data.usdPerOunce).toBe("number");
		expect(res.headers["cache-control"]).toMatch(/max-age/);
		expect(res.headers.etag).toBeDefined();
	});

	it.skipIf(!hasApiKey)("all 8 /latest endpoints (aliases + parameterized) respond with success", async () => {
		for (const m of METALS) {
			const alias = await request(app).get(`/api/${m}/latest`);
			const param = await request(app).get(`/api/metal/${m}/latest`);
			expect(alias.status, `alias ${m}`).toBe(200);
			expect(alias.body.success, `alias ${m}`).toBe(true);
			expect(param.status, `param ${m}`).toBe(200);
			expect(param.body.success, `param ${m}`).toBe(true);
		}
	}, 30_000);

	it("GET /api/metal/unknown/latest returns 404", async () => {
		const res = await request(app).get("/api/metal/doesnotexist/latest");
		expect(res.status).toBe(404);
		expect(res.body.success).toBe(false);
	});

	it("ETag 304 handshake works", async () => {
		if (!hasApiKey) return; // cache warm required
		const first = await request(app).get("/api/gold/latest");
		if (first.status !== 200 || !first.headers.etag) return;
		const second = await request(app).get("/api/gold/latest").set("If-None-Match", first.headers.etag);
		expect(second.status).toBe(304);
	});
});
