import { describe, it, expect } from "vitest";

process.env.NODE_ENV = "test";
await import("../src/config.js");
const hasApiKey = !!process.env.METALPRICE_API_KEY;

// server.ts constructs MetalpriceClient at import (throws without a key), so
// gate on the key like smoke.test.ts does.
const mod = hasApiKey ? await import("../src/server.js") : null;
const compactSeries = mod?.compactSeries;

const DAY = 86_400_000;

describe.skipIf(!hasApiKey)(
  "compactSeries: point cap must never evict history",
  () => {
    it("5000 recent intraday points do NOT evict a point from 365 days ago (regression 2026-08)", () => {
      const now = Date.now();
      const yearAgo = now - 365 * DAY;
      const series: { t: number; v: number }[] = [];

      // 1 daily point per day for the past 2 years (the "history"), ending
      // just outside the 3-day intraday window.
      for (let d = 730; d >= 4; d--) {
        series.push({ t: now - d * DAY, v: 100 + d });
      }
      const historyCount = series.length;

      // Then a realistic flood: 5000 intraday points spread over the last 30
      // days (~167/day). This is what a warm container accumulates — and it's
      // >4000 on its own, so the OLD naive cap would have evicted the entire
      // 2-year history to make room for it.
      for (let i = 5000; i > 0; i--) {
        series.push({ t: now - Math.floor((i / 5000) * 30 * DAY), v: 50 });
      }
      expect(series.length).toBeGreaterThan(4000);

      const out = compactSeries!(series);

      // The old naive splice(0, len-4000) would have discarded the ENTIRE
      // 2-year history to keep the 5000 intraday points. The fix must keep the
      // history and collapse the intraday instead.
      const oldest = out[0]!;
      expect(oldest.t).toBeLessThanOrEqual(yearAgo); // history from ≥1yr ago survives

      // Every historical (older-than-7d) day is still represented — at
      // least the full 2-year daily history count (intraday inside days 4-30
      // merges into those same days at 1/day, so the count can't be lower).
      const oldDays = new Set(
        out
          .filter((p) => p.t < now - 3 * DAY)
          .map((p) => Math.floor(p.t / DAY)),
      );
      expect(oldDays.size).toBeGreaterThanOrEqual(historyCount);

      // And the total is under the cap (intraday got collapsed, not history).
      expect(out.length).toBeLessThanOrEqual(4000);
      // Output stays sorted ascending.
      for (let i = 1; i < out.length; i++)
        expect(out[i]!.t).toBeGreaterThanOrEqual(out[i - 1]!.t);
    });

    it("keeps full intraday resolution inside the retention window", () => {
      const now = Date.now();
      const series = [];
      // 288 points today (5-min cadence), all should survive untouched.
      for (let i = 0; i < 288; i++)
        series.push({ t: now - i * 5 * 60_000, v: i });
      const out = compactSeries!(series);
      expect(out.length).toBe(288);
    });

    it("collapses old intraday to one point per UTC day (keeps the last sample)", () => {
      const now = Date.now();
      const oldDay = Math.floor((now - 30 * DAY) / DAY) * DAY; // a UTC-midnight 30d ago
      const series = [
        { t: oldDay + 1 * 3_600_000, v: 1 },
        { t: oldDay + 5 * 3_600_000, v: 2 },
        { t: oldDay + 23 * 3_600_000, v: 3 }, // last of that day
      ];
      const out = compactSeries!(series);
      expect(out.length).toBe(1);
      expect(out[0]!.v).toBe(3);
    });
  },
);
