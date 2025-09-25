import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { MetalpriceClient } from "../src/metalpriceClient.js";

type Row = { date: string; usdPerMetricTon: number; usdPerPound: number };

// Convert API units for cobalt to USD per metric ton
// API returns unitsPerUsd for XCO (cobalt) in ounces (avoirdupois) per USD.
// We convert to USD/metric ton for a more practical unit.
const OUNCE_GRAMS = 28.349523125;
const METRIC_TON_GRAMS = 1_000_000;
const POUND_GRAMS = 453.59237;

function ouncesToUsdPerMetricTon(unitsPerUsd: number): number {
  const usdPerOunce = 1 / unitsPerUsd;
  const usdPerGram = usdPerOunce / OUNCE_GRAMS;
  return usdPerGram * METRIC_TON_GRAMS;
}

function ouncesToUsdPerPound(unitsPerUsd: number): number {
  const usdPerOunce = 1 / unitsPerUsd;
  const usdPerGram = usdPerOunce / OUNCE_GRAMS;
  return usdPerGram * POUND_GRAMS;
}

async function main() {
  const client = new MetalpriceClient();

  // Pull last 5 years of daily data. We'll fetch in chunks to respect plan limits.
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  async function fetchChunk(s: Date, e: Date): Promise<Row[]> {
    const tf = await client.fetchTimeframe({
      start_date: fmt(s),
      end_date: fmt(e),
      base: "USD",
      currencies: ["XCO"],
    });
    if (!tf || tf.success === false || !tf.rates) {
      throw new Error(`API error fetching timeframe chunk ${fmt(s)}..${fmt(e)}: ${tf?.error?.code} ${tf?.error?.info}`);
    }
    const dates = Object.keys(tf.rates).sort();
    const rows: Row[] = [];
    for (const date of dates) {
      const unitsPerUsd = tf.rates[date]?.["XCO"];
      if (unitsPerUsd == null) continue;
      const usdPerMetricTon = ouncesToUsdPerMetricTon(unitsPerUsd);
      const usdPerPound = ouncesToUsdPerPound(unitsPerUsd);
      rows.push({
        date,
        usdPerMetricTon: Number(usdPerMetricTon.toFixed(2)),
        usdPerPound: Number(usdPerPound.toFixed(2)),
      });
    }
    return rows;
  }

  // Iterate by 90-day chunks
  const rows: Row[] = [];
  const chunkMs = 90 * 24 * 60 * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += chunkMs) {
    const s = new Date(t);
    const e = new Date(Math.min(t + chunkMs - 24 * 60 * 60 * 1000, end.getTime()));
    const part = await fetchChunk(s, e);
    rows.push(...part);
    // tiny delay to be nice to the API on lower plans
    await new Promise((r) => setTimeout(r, 200));
  }

  // De-duplicate and sort rows (some APIs include both ends)
  const map = new Map<string, Row>();
  for (const r of rows) map.set(r.date, r);
  const finalRows = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Build worksheet and workbook
  const ws = XLSX.utils.json_to_sheet(finalRows, { header: ["date", "usdPerMetricTon", "usdPerPound"] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "CobaltDaily");

  // Autoset column widths
  (ws as any)["!cols"] = [{ wch: 12 }, { wch: 18 }, { wch: 14 }];

  const outDir = path.join(process.cwd(), "exports");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "cobalt_daily.xlsx");
  XLSX.writeFile(wb, outPath);
  console.log(`Exported ${finalRows.length} rows to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


