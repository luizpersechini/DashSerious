# DashSerious — Commodities & FX Dashboard

> Live prices · interactive charts · market news · dark trading-desk UI

**Live:** https://dashboard-1056503697671.southamerica-east1.run.app

---

## What it is

A self-hosted financial dashboard tracking precious metals, industrial metals, and USD/BRL FX in real time. Prices are fetched from [MetalpriceAPI](https://metalpriceapi.com), cached server-side, and served through a clean Express API. The frontend is a single-page React app (Babel Standalone, no build step) with TradingView Lightweight Charts and an accumulating commodity news feed from [NewsData.io](https://newsdata.io).

---

## Tracked instruments

| Symbol | Name | Unit displayed |
|--------|------|----------------|
| XAU | Gold | USD / troy oz |
| XAG | Silver | USD / troy oz |
| XPT | Platinum | USD / troy oz |
| XPD | Palladium | USD / troy oz |
| XCU | Copper | USD / lb |
| NI | Nickel | USD / lb |
| XCO | Cobalt | USD / metric ton |
| BRL | USD → BRL FX | BRL per USD |

---

## Features

### Prices & data
- **Plan-aware refresh cadence** — auto-configured from `METALPRICE_PLAN` (Essential: 30 min → Business: 15 s)
- **5-year historical seed** on startup, gap-filled on restarts (only missing date ranges re-fetched)
- **Persistent timeseries** written to `data/timeseries.json`; survives cold restarts without re-fetching history
- **24h rolling change chip** — uses `date_type=recent` (yesterday's close → live price) for a true rolling delta
- **Request coalescing** — concurrent cache-miss requests share a single upstream call

### Charts
- TradingView Lightweight Charts v4.2.1 with metal-specific accent colors
- Timeframe selector: **1D · 5D · 30D · 90D · 180D · 1YR · 2YR · 3YR · ALL**
- Periodicity: daily / weekly / monthly averaged aggregation
- Time-based filtering (`?since_ts=<epoch-ms>`) — correct window regardless of point density
- Chart style toggle: **area** or **bar** (default: bar)

### News feed
- Pulls commodity & FX articles from NewsData.io (free tier: 200 calls/day)
- **Accumulating cache** — articles build up over 48 h rolling window instead of replacing on each refresh
- Per-metal filter chips (XAU · XAG · XPT · XPD · XCU · NI · XCO · BRL)
- Refreshes every 30 minutes server-side; deduplicates by normalised title

### UI
- Dark trading-desk theme — custom CSS design tokens (`--bg`, `--surface`, `--muted`, `--dim`, etc.)
- Two layout modes: **editorial** (magazine-style) and **grid**
- Density toggle: comfortable / compact
- Currency display toggle: USD / BRL
- Tweaks panel for live layout / chart style / accent strength adjustments
- Fully responsive — mobile, tablet, desktop
- Version stamp in footer via `/api/version`

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+, TypeScript 5.9 |
| Server | Express 5.1 |
| Frontend | React 18 (Babel Standalone — no build step) |
| Charts | TradingView Lightweight Charts v4.2.1 |
| Price API | MetalpriceAPI (`/latest`, `/timeframe`, `/change`) |
| News API | NewsData.io (`/latest`) |
| Persistence | File-backed JSON (`data/timeseries.json`) |
| Testing | Vitest + supertest |
| Container | Docker (multi-stage) |
| CI/CD | GitHub Actions → Google Cloud Run (São Paulo) |

---

## Getting started

### Prerequisites
- Node.js 18+
- A [MetalpriceAPI](https://metalpriceapi.com) key (free tier works)
- Optionally a [NewsData.io](https://newsdata.io) key for the news feed

### Install & run

```bash
git clone https://github.com/luizpersechini/DashSerious.git
cd DashSerious
npm install
```

Create `.env`:

```env
METALPRICE_API_KEY=your_key_here
METALPRICE_API_BASE=https://api.metalpriceapi.com/v1
METALPRICE_PLAN=essential          # essential | basic | basicplus | professional | business
NEWS_API_KEY=your_newsdata_key     # optional — news feed hidden if omitted
```

```bash
npm run dev        # dev server with hot reload → http://localhost:3000
npm run build      # tsc → dist/
npm start          # production (node dist/server.js)
```

### Refresh cadence by plan

| Plan | Auto interval |
|------|--------------|
| Essential | 30 min |
| Basic | 10 min |
| Basic Plus / Professional | 60 s |
| Professional Plus | 30 s |
| Business | 15 s |

Override with `METALPRICE_REFRESH_MINUTES=N` in `.env`.

---

## API reference

```
GET  /api/metal/:symbol/latest      → { success, usdPerOunce, usdPerGram, ... }
GET  /api/metal/:symbol/timeseries  → { points: [{t, v}] }   ?since_ts=<ms> &limit=N
GET  /api/metal/:symbol/change      → { direction, pct }
GET  /api/news                      → { items: NewsItem[], configured: bool }
GET  /api/version                   → { version: "1.x.x" }
GET  /health                        → { ok, cacheWarm, cachedSymbols, uptimeMs }
POST /api/refresh                   → forces immediate upstream refetch
```

Convenience aliases: `/api/gold/latest`, `/api/silver/latest`, `/api/copper/latest`, etc.

HTTP caching: `Cache-Control: public, max-age=30` + weak `ETag` / `304` on `/latest`; `no-store` on `/timeseries`.

---

## Project structure

```
src/
  server.ts           Express entry point, routes, caching, readiness gate
  metalpriceClient.ts MetalpriceAPI TypeScript client
  newsClient.ts       NewsData.io client — fetch, tag, deduplicate articles
  storage.ts          Timeseries persistence (load on boot, autosave + SIGTERM flush)
  config.ts           .env loader and typed config exports

public/
  index.html          Single-page React dashboard (all components inline, Babel Standalone)
  styles.css          Global CSS design tokens and resets
  *.html              Per-metal detail pages (gold, silver, platinum, palladium, copper, nickel, cobalt, brl)
  shared/
    chart.js          Shared chart helpers (colors, aggregators, renderChart)
    detail.js         Detail page bootstrap — each HTML shell calls DashDetail.init({ key })

scripts/
  fetchGold.ts        CLI integration test / manual gold fetch
  exportCobalt.ts     Export cobalt daily history → exports/cobalt_daily.xlsx

test/
  smoke.test.ts       Vitest + supertest: health, aliases, parameterized routes, ETag, 404

data/                 Runtime only, gitignored — holds timeseries.json
exports/              Excel exports, gitignored
```

---

## Docker

```bash
# Build
docker build -t dashserious:latest .

# Run
docker run -p 3000:3000 \
  -e METALPRICE_API_KEY=$METALPRICE_API_KEY \
  -e METALPRICE_PLAN=${METALPRICE_PLAN:-essential} \
  -e NEWS_API_KEY=$NEWS_API_KEY \
  dashserious:latest
```

Or with Compose:

```bash
# copy .env, then:
docker compose up --build -d
docker compose down
```

---

## Deploying to Cloud Run

The GitHub Actions workflow (`.github/workflows/deploy-cloud-run.yml`) deploys automatically on every push to `main`.

**Required GitHub secrets:**

| Secret | Value |
|--------|-------|
| `GCP_SA_KEY_JSON` | Service account JSON key with Artifact Registry + Cloud Run roles |
| `METALPRICE_API_KEY` | MetalpriceAPI key |
| `NEWS_API_KEY` | NewsData.io key |

Every push to `main` → builds Docker image → pushes to Artifact Registry (São Paulo) → deploys to Cloud Run → live in ~2 min.

**Manual one-shot deploy:**

```bash
gcloud auth login
gcloud config set project hip-principle-473317-j4
gcloud config set run/region southamerica-east1

gcloud builds submit --region southamerica-east1 \
  --tag southamerica-east1-docker.pkg.dev/hip-principle-473317-j4/dashboard-repo/dashboard:latest

gcloud run deploy dashboard \
  --image southamerica-east1-docker.pkg.dev/hip-principle-473317-j4/dashboard-repo/dashboard:latest \
  --platform managed --allow-unauthenticated \
  --set-env-vars METALPRICE_API_KEY=$METALPRICE_API_KEY,METALPRICE_PLAN=essential,NEWS_API_KEY=$NEWS_API_KEY
```

---

## Testing

```bash
npm test             # vitest run (single pass)
npm run test:watch   # watch mode
```

The smoke suite boots the server in-process, awaits the readiness gate, and verifies health, all `/latest` aliases + parameterized routes, 404 on unknown symbol, and ETag → 304 roundtrip. Auto-skips when `METALPRICE_API_KEY` is not set.

---

## Cobalt Excel export

```bash
npm run export:cobalt
# → exports/cobalt_daily.xlsx  (date, usdPerMetricTon, usdPerPound — 5 years daily)
```

---

## Security

- API keys are server-side only; the browser never sees them.
- `.env` is gitignored. Never commit secrets.
- If a key is accidentally committed, rotate it immediately at the provider dashboard.

---

## Version history

| Version | Summary |
|---------|---------|
| v1.2.3 | Contrast pass — muted/dim tokens, chip readability, tag badges, news titles |
| v1.2.2 | News accumulation — rolling 48h window instead of replace-on-refresh |
| v1.2.1 | Inactive news filter chip contrast fix |
| v1.2.0 | Market news feed (NewsData.io), version tracking, CI wired for `NEWS_API_KEY` |
| v1.1.x | 1D/5D timeframes, y-axis labels removed, mobile layout |
| v1.0.x | Initial release — metals dashboard, TradingView charts, Cloud Run deploy |
