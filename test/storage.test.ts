import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Point DATA_DIR at a throwaway temp dir BEFORE importing storage, so these
// tests never touch the real data/ directory.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "dash-storage-"));
process.env.DATA_DIR = TMP;

const storage = await import("../src/storage.js");

describe("storage: timeseries round-trip", () => {
  it("persist then hydrate returns the same data", async () => {
    const src = new Map<string, { t: number; v: number }[]>();
    src.set("XAU", [
      { t: 1000, v: 4400 },
      { t: 2000, v: 4410 },
    ]);
    src.set("XCU", [{ t: 1500, v: 6.34 }]);

    await storage.persistTimeseries(src);

    const restored = new Map<string, { t: number; v: number }[]>();
    const res = await storage.hydrateTimeseries(restored);
    expect(res.loaded).toBe(true);
    expect(res.symbols).toBe(2);
    expect(restored.get("XAU")).toEqual([
      { t: 1000, v: 4400 },
      { t: 2000, v: 4410 },
    ]);
    expect(restored.get("XCU")).toEqual([{ t: 1500, v: 6.34 }]);
  });
});

describe("storage: generic JSON round-trip (calibration)", () => {
  it("persistJson then hydrateJson returns the same object", async () => {
    const data = {
      version: 1,
      savedAt: 12345,
      bySymbol: {
        XCU: [{ ts: 1, ourValue: 6.35, refValue: 6.34, diffPct: 0.16 }],
      },
    };
    await storage.persistJson("calibration.json", data);
    const restored = await storage.hydrateJson<typeof data>("calibration.json");
    expect(restored).toEqual(data);
  });

  it("hydrateJson returns null for a missing file (graceful degrade)", async () => {
    const restored = await storage.hydrateJson("does-not-exist.json");
    expect(restored).toBeNull();
  });
});

describe("storage: DATA_DIR env override is respected", () => {
  it("writes into the configured temp dir, not ./data", async () => {
    const src = new Map<string, { t: number; v: number }[]>();
    src.set("XAG", [{ t: 1, v: 75 }]);
    await storage.persistTimeseries(src);
    // The file must exist under our TMP dir.
    const stat = await fs.stat(path.join(TMP, "timeseries.json"));
    expect(stat.isFile()).toBe(true);
  });
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});
