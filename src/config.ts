import fs from "node:fs";
import path from "node:path";

// Lightweight .env loader to avoid extra deps
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

export const config = {
  metalpriceApiKey: process.env.METALPRICE_API_KEY || "",
  metalpriceApiBase:
    process.env.METALPRICE_API_BASE || "https://api.metalpriceapi.com/v1",
  metalpricePlan: (process.env.METALPRICE_PLAN || "essential").toLowerCase(),
  metalpriceMonthlyQuota: Number(
    process.env.METALPRICE_MONTHLY_QUOTA || "1000",
  ),
  manualRefreshMinutes: process.env.METALPRICE_REFRESH_MINUTES
    ? Number(process.env.METALPRICE_REFRESH_MINUTES)
    : undefined,
  seedDepthDays: Number(process.env.SEED_DEPTH_DAYS || "1825"), // default 5 years
  newsApiKey: process.env.NEWS_API_KEY || "",
  // Security (audit 2026-05-20)
  // Shared secret required to call POST /api/refresh (H1). If empty, refresh is
  // allowed (back-compat) but a warning is logged at startup.
  refreshToken: process.env.REFRESH_TOKEN || "",
  // Comma-separated CORS allow-list (H3). Empty => same-origin only.
  // e.g. CORS_ALLOW_ORIGINS=https://dash.example.com,http://localhost:5173
  corsAllowOrigins: (process.env.CORS_ALLOW_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
};

export function assertConfig() {
  if (!config.metalpriceApiKey) {
    throw new Error(
      "Missing METALPRICE_API_KEY in .env. Add it to .env (never commit secrets).",
    );
  }
}
