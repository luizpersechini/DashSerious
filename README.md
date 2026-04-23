# Commodities Dashboard (MetalpriceAPI)

A minimal Node.js + TypeScript dashboard that shows live prices for several metals using MetalpriceAPI.

🌐 **Live Demo:** https://dashboard-1056503697671.southamerica-east1.run.app

## Overview

- Backend: Express server that fetches MetalpriceAPI, caches results, and serves a small API + static page.
- Frontend: Static HTML page with responsive grid cards, dark trading-desk look, and professional financial charts.
- Charting: TradingView Lightweight Charts (v4.2.1) for professional, interactive price visualization.
- Data Provider: MetalpriceAPI (`/latest`, `/timeframe`, `/change`) with API key auth.

## Features

- Parameterized API with per-metal aliases, in-memory caching, and plan-aware periodic refresh:
  - Parameterized: `GET /api/metal/:name/latest | /timeseries | /change`
  - Aliases (backwards compatible):
    - `GET /api/gold/latest`, `/api/silver/latest`, `/api/platinum/latest`, `/api/palladium/latest`
    - `GET /api/copper/latest`, `/api/nickel/latest` (symbol `NI`), `/api/cobalt/latest`
    - `GET /api/brl/latest` (USD→BRL FX)
  - Ops: `GET /health` → `{ok, cacheWarm, cachedSymbols, seedComplete, uptimeMs}`
  - Mutation: `POST /api/refresh` forces an immediate upstream refetch
- Response caching: `Cache-Control: public, max-age=30` + weak `ETag` on `/latest`, with `If-None-Match` → `304` handshake
- Unit handling
  - Precious metals (XAU, XAG, XPT, XPD): prices in USD/oz (troy) and internal conversion to USD/g
  - Others (XCU, NI, XCO): prices in USD/oz (avoirdupois) with USD/g
  - Copper and Nickel also expose USD/lb for convenience on the API, and UI shows USD/lb to 4 decimals
- Static page at `/` shows one price per metal:
  - Copper/Nickel: USD/lb (4 decimals)
  - Others: USD/oz (2 decimals)
  - Cobalt: USD/metric ton (no decimals)
  - BRL card: USD/BRL FX (4 decimals)
- UX: skeleton shimmer while loading, visible "Couldn't load — Retry" affordance on failure, 24h price-change chip next to each price (green/red/grey), `aria-label` on all form controls

### Charts & Refresh Strategy

- Multi-symbol fetch cadence is plan-aware (auto-set based on your subscription)
- In-memory time series buffer per metal (`/api/:metal/timeseries?limit=N`)
- One-time historical seed: 360 days via timeframe endpoint
- **Professional TradingView Lightweight Charts** with:
  - Interactive area series with gradients matching metal-specific colors
  - Dark theme with transparent backgrounds
  - Left-side Y-axis with smart number formatting (no decimals for values >1000, comma separators)
  - Date-only crosshair labels (no time display)
  - Responsive charts with optimized ResizeObserver (prevents viewport expansion on mobile/iPad)
  - No branding/watermarks
- Timeframe options on both main and detail pages: 30d, 90d, 180d, 1yr
- Periodicity options: Daily, Weekly (averaged), Monthly (averaged)
- Values displayed in the same units as the card; BRL shows USD→BRL exchange rate

### UI / Styling

- Dark theme with gradient background and sleek cards
- Per-metal accent colors on card headers and charts (gold/silver/platinum/palladium/copper/nickel/cobalt/brl)
- Inter font loaded from Google Fonts
- Locale-aware number formatting via `Intl.NumberFormat` for clean currency display
- All metal cards are clickable and navigate to dedicated detail pages
- Header currency selector (USD/BRL) switches price display for metal cards; charts also scale when BRL is selected

## Getting Started

1. Requirements
   - Node.js 18+

2. Install
```bash
npm install
```

3. Configure environment
Create `.env` using `.env.template` as reference:
```
METALPRICE_API_KEY=YOUR_KEY
METALPRICE_API_BASE=https://api.metalpriceapi.com/v1
```

4. Run in development
```bash
npm run dev
```
Visit `http://localhost:3000`.

#### Configure refresh cadence by plan

The server auto-sets refresh based on your plan, and you can override it.

- **Current plan**: Basic Plus ($21.99/month, 50,000 requests/month, 60-second updates)
- Supported plans (case-insensitive): `essential`, `basic`, `basicplus`, `professional`, `professionalplus`, `business`.
- Defaults used:
  - Essential: 30 minutes
  - Basic: 10 minutes
  - Basic Plus / Professional: 60 seconds ⭐ **(Current)**
  - Professional Plus: 30 seconds
  - Business: 15 seconds

To configure via `.env`:

```
METALPRICE_PLAN=basicplus
# Optional manual override (minutes) – takes precedence over plan
# METALPRICE_REFRESH_MINUTES=1
```

#### Manual Refresh Button

The main dashboard includes a "Refresh" button in the top-right corner that lets you manually trigger an immediate data refresh from the API, bypassing the automatic refresh interval. This is useful when you need the most up-to-date prices without waiting for the next scheduled update.

5. Build and run
```bash
npm run build
npm run start
```

## Project Structure

- `src/config.ts` – Minimal `.env` loader and config exports
- `src/metalpriceClient.ts` – Tiny client for MetalpriceAPI `/latest`, `/timeframe`, `/change`
- `src/server.ts` – Express server, routes, caching, readiness gate, `/health`, static hosting
- `src/storage.ts` – Persists the in-memory timeseries to `data/timeseries.json` (autosave + SIGTERM flush)
- `public/index.html` – Dashboard (cards + Lightweight Charts; all cards link to detail pages)
- `public/shared/chart.js` – Shared chart/series helpers (colors, aggregators, `renderChart`, `fetchWithRetry`)
- `public/shared/detail.js` – Shared bootstrap for the 8 detail pages — each HTML file just calls `DashDetail.init({ key })`
- `public/gold.html`, `silver.html`, `platinum.html`, `palladium.html`, `copper.html`, `nickel.html`, `cobalt.html`, `brl.html` – Per-metal detail pages (thin shells; all logic lives in `public/shared/detail.js`)
- `test/smoke.test.ts` – Vitest + supertest smoke suite (health, aliases, parameterized routes, 404, ETag handshake)
- `scripts/fetchGold.ts` – CLI script used to verify initial integration
- `scripts/exportCobalt.ts` – Exports cobalt daily history to Excel (USD/ton and USD/lb)
- `data/` – Runtime-only, gitignored. Holds `timeseries.json` so cold starts don't re-fetch the 360-day seed.

## Notes & Decisions

- API key is kept server-side only; front-end calls local API.
- Nickel symbol is `NI` (confirmed via `/symbols` endpoint). UI label reflects `NI`.
- Conversions:
  - Troy ounce (precious): 31.1034768 g
  - Avoirdupois ounce: 28.349523125 g
  - Pound: 453.59237 g
- Refresh interval is set to 60 seconds by default.
- Cobalt additionally exposes USD/metric ton on the API and UI

## References

- MetalpriceAPI docs (auth, latest, symbols, units):
  - https://metalpriceapi.com/documentation

## Technical Stack

- **Backend**: Node.js 18+, TypeScript 5.9, Express 5.1
- **Frontend**: Vanilla HTML/CSS/JavaScript (no frameworks) — shared helpers in `public/shared/*.js`
- **Charts**: TradingView Lightweight Charts v4.2.1
- **Styling**: Custom CSS with Inter font (Google Fonts)
- **API Client**: Custom MetalpriceAPI TypeScript client (`/latest`, `/timeframe`, `/change`)
- **Persistence**: File-backed timeseries cache (`data/timeseries.json`) with autosave + SIGTERM flush
- **Testing**: Vitest + supertest smoke suite
- **Deployment**: Docker, Google Cloud Run
- **CI/CD**: GitHub Actions

## Technical Improvements & Bug Fixes

### First-Load Reliability (v3)

**Problem Solved:**
Cards occasionally rendered empty on the very first page load. The server was calling `app.listen()` before `refreshAllSymbols()` had resolved, and the frontend silently swallowed the resulting 503 responses.

**Solution Implemented:**
- A readiness `Promise` (bounded to 10 s) is awaited by an `/api/*` middleware, so no `/latest` handler runs against a cold cache.
- On cache miss, a single in-flight `coalesceRefresh()` serves all waiters — the first paint no longer fans out into 8 concurrent per-symbol upstream calls.
- Frontend `fetch` calls now use `AbortController` (8 s timeout) with one automatic retry, surfacing failures via a visible "Couldn't load — Retry" affordance instead of leaving blanks.
- `timeseriesBySymbol` is hydrated from `data/timeseries.json` on boot and flushed on SIGTERM + every 5 min, so cold starts don't re-fetch 360 days of history.

### Responsive Chart Implementation (v2)

The dashboard uses an optimized ResizeObserver pattern to prevent viewport expansion issues on mobile devices (especially iPads):

**Problem Solved:**
- Charts were causing horizontal viewport expansion beyond screen edges
- ResizeObserver feedback loops occurred when tabs became inactive
- Chart containers could grow unbounded on mobile devices

**Solution Implemented:**
- Charts are sized based on parent card width minus padding (44px)
- ResizeObserver monitors the **card element** (parent), not the chart container itself
- CSS constraints added: `overflow: hidden` and `max-width: 100%` on both cards and chart containers
- Width change detection prevents unnecessary chart updates
- ResizeObserver cleanup on chart re-render prevents memory leaks

This ensures charts remain responsive to window resizing while never expanding beyond their container boundaries.

## Testing

```bash
npm test          # one-shot Vitest run
npm run test:watch
```

`test/smoke.test.ts` boots the server in-process (NODE_ENV=test skips `app.listen`), awaits the readiness gate, and verifies:

- `GET /health` responds `ok:true`
- All 8 alias + 8 parameterized `/latest` endpoints return `success:true` with a `Cache-Control` header and a weak `ETag`
- `GET /api/metal/unknown/latest` → 404
- `If-None-Match` on a fresh `ETag` → 304

The suite auto-skips when `METALPRICE_API_KEY` is not set.

## Future Enhancements (optional)

- ✅ ~~Add 24h change using the `change` endpoint~~ (shipped as the change-chip next to each price)
- ✅ ~~Persisted caching (file or Redis) to survive restarts~~ (file-based via `src/storage.ts`; Redis remains optional for multi-instance)
- ✅ ~~Small UI improvements (loading/error states)~~ (skeleton shimmer + visible retry affordance)
- ✅ ~~Shared JS module for detail charts to reduce duplication~~ (`public/shared/chart.js` + `public/shared/detail.js`)
- Export functionality for other metals (similar to cobalt export)
- Redis-backed cache for horizontal scaling on Cloud Run (multi-instance)
- Server-side rendering of detail pages to collapse the 8 HTML shells into one template

## Detail Pages

Each metal card **and BRL** links to a dedicated detail page under `/public` with:
- **TradingView Lightweight Charts**: Professional area series with interactive crosshair and responsive behavior
- **Timeframe selector**: 30d / 90d / 180d / 1yr (matching main dashboard options)
- **Periodicity**: daily / weekly / monthly (averaged)
- **Smart Y-axis formatting**: 
  - Values ≥1000: No decimals, with comma separators (e.g., "2,500")
  - Values 1-999: 2 decimal places (e.g., "45.32")
  - Values <1: 2-4 decimal places (e.g., "0.4567")
- **Date-only crosshair**: Shows date without time for cleaner display
- **Left-side Y-axis**: Professional trading platform style
- **Metal-specific colors**: Each chart uses the metal's accent color from the main dashboard
- Title shows the commodity name; a subtitle under the title shows the display unit (e.g., USD/oz, USD/lb, USD/ton)
- "Back" button to return to main dashboard

Units per page:
- Gold, Silver, Platinum, Palladium: USD/oz
- Copper, Nickel: USD/lb (4 decimals)
- Cobalt: USD/ton (no decimals)
- **BRL**: USD/BRL exchange rate (4 decimals)

## Cobalt Export (Excel)

Generates a spreadsheet with daily cobalt history over the last 5 years containing `date`, `usdPerMetricTon`, and `usdPerPound`.

1) Ensure `.env` has `METALPRICE_API_KEY` and optional `METALPRICE_API_BASE`.
2) Install deps: `npm install`
3) Run: `npm run export:cobalt`
4) Output: `exports/cobalt_daily.xlsx`


## Security / Secrets

- API keys are loaded from `.env` via `src/config.ts`. Never commit `.env` to version control.
- `.gitignore` excludes `.env`, build outputs, and `exports/` artifacts.
- If a key is ever committed by mistake, rotate it immediately in the provider dashboard and remove it from history if required.


## Docker Deployment

Build a production image (multi-stage) and run:

```bash
# Build
docker build -t dashboard:latest .

# Run with env (ensure your key is set)
docker run -p 3000:3000 \
  -e METALPRICE_API_KEY=$METALPRICE_API_KEY \
  -e METALPRICE_API_BASE=${METALPRICE_API_BASE:-https://api.metalpriceapi.com/v1} \
  -e METALPRICE_PLAN=${METALPRICE_PLAN:-essential} \
  --name dashboard dashboard:latest
```

Visit `http://localhost:3000`.

### docker-compose (one command)

1) Ensure your Metalprice API key is in your shell env (do not commit it):

```bash
export METALPRICE_API_KEY=YOUR_KEY
```

2) Start with Compose:

```bash
docker compose up --build -d
```

3) Stop:

```bash
docker compose down
```

## Google Cloud Run (free tier) – South America default

Pre-reqs: `gcloud` CLI installed, project `hip-principle-473317-j4`, billing enabled.

Region and repo used below:
- Region: `southamerica-east1` (São Paulo)
- Repo: `dashboard-repo`

```bash
# Auth and defaults
gcloud auth login
gcloud config set project hip-principle-473317-j4
gcloud config set run/region southamerica-east1
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# Create Artifact Registry repo (one-time)
gcloud artifacts repositories create dashboard-repo \
  --repository-format=docker --location=southamerica-east1 \
  --description="Dashboard images"

# Build and push with Cloud Build (no local Docker required)
gcloud builds submit --region southamerica-east1 \
  --tag southamerica-east1-docker.pkg.dev/hip-principle-473317-j4/dashboard-repo/dashboard:latest

# Deploy to Cloud Run (allow unauthenticated)
export METALPRICE_API_KEY=YOUR_KEY
gcloud run deploy dashboard \
  --image southamerica-east1-docker.pkg.dev/hip-principle-473317-j4/dashboard-repo/dashboard:latest \
  --platform managed --allow-unauthenticated \
  --set-env-vars METALPRICE_API_KEY=$METALPRICE_API_KEY,METALPRICE_API_BASE=${METALPRICE_API_BASE:-https://api.metalpriceapi.com/v1},METALPRICE_PLAN=${METALPRICE_PLAN:-essential}

# Get URL
gcloud run services describe dashboard --region southamerica-east1 --format='value(status.url)'
```

You can also customize `cloudrun-service.yaml` and deploy via:

```bash
gcloud run services replace cloudrun-service.yaml
```

### GitHub Actions: Auto-deploy to Cloud Run

Workflow file: `.github/workflows/deploy-cloud-run.yml` deploys on pushes to `feature/deploy-web` or `main`.

#### Prerequisites

1. **Enable Google Cloud APIs** (one-time setup):
   ```bash
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
   ```

2. **Create Artifact Registry repository** (one-time setup):
   ```bash
   gcloud artifacts repositories create dashboard-repo \
     --repository-format=docker --location=southamerica-east1 \
     --description="Dashboard images" --project hip-principle-473317-j4
   ```

3. **Create service account for CI/CD** (one-time setup):
   ```bash
   # Create service account
   gcloud iam service-accounts create dashboard-deployer \
     --display-name="Dashboard CI/CD" \
     --project hip-principle-473317-j4
   
   # Grant required roles
   gcloud projects add-iam-policy-binding hip-principle-473317-j4 \
     --member serviceAccount:dashboard-deployer@hip-principle-473317-j4.iam.gserviceaccount.com \
     --role roles/artifactregistry.writer
   
   gcloud projects add-iam-policy-binding hip-principle-473317-j4 \
     --member serviceAccount:dashboard-deployer@hip-principle-473317-j4.iam.gserviceaccount.com \
     --role roles/run.admin
   
   gcloud projects add-iam-policy-binding hip-principle-473317-j4 \
     --member serviceAccount:dashboard-deployer@hip-principle-473317-j4.iam.gserviceaccount.com \
     --role roles/iam.serviceAccountUser
   
   # Create JSON key
   gcloud iam service-accounts keys create dashboard-deployer-key.json \
     --iam-account dashboard-deployer@hip-principle-473317-j4.iam.gserviceaccount.com
   ```

4. **Set GitHub repository secrets**:
   - `GCP_SA_KEY_JSON`: Contents of `dashboard-deployer-key.json` file
   - `METALPRICE_API_KEY`: Your MetalpriceAPI key

#### Deployment Process

Every push to `main` or `feature/deploy-web` automatically:
1. Builds Docker image
2. Pushes to Artifact Registry (`southamerica-east1-docker.pkg.dev/hip-principle-473317-j4/dashboard-repo/dashboard`)
3. Deploys to Cloud Run service in São Paulo region
4. Updates live site at: https://dashboard-1056503697671.southamerica-east1.run.app

The entire CI/CD process takes ~2-3 minutes.


