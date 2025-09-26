# Commodities Dashboard (MetalpriceAPI)

A minimal Node.js + TypeScript dashboard that shows live prices for several metals using MetalpriceAPI.

## Overview

- Backend: Express server that fetches MetalpriceAPI, caches results, and serves a small API + static page.
- Frontend: Static HTML page with responsive grid cards and dark trading-desk look.
- Data Provider: MetalpriceAPI (`/latest`, `timeframe`) with API key auth.

## Features

- Per-metal endpoints with in-memory caching and periodic refresh (60s):
  - `GET /api/gold/latest`
  - `GET /api/silver/latest`
  - `GET /api/platinum/latest`
  - `GET /api/palladium/latest`
  - `GET /api/copper/latest`
  - `GET /api/nickel/latest` (symbol `NI`)
  - `GET /api/cobalt/latest`
  - `GET /api/brl/latest` (USD→BRL FX)
- Unit handling
  - Precious metals (XAU, XAG, XPT, XPD): prices in USD/oz (troy) and internal conversion to USD/g
  - Others (XCU, NI, XCO): prices in USD/oz (avoirdupois) with USD/g
  - Copper and Nickel also expose USD/lb for convenience on the API, and UI shows USD/lb to 4 decimals
- Static page at `/` shows one price per metal:
  - Copper/Nickel: USD/lb (4 decimals)
  - Others: USD/oz (2 decimals)
  - Cobalt: USD/metric ton (no decimals)
  - BRL card: USD/BRL FX (4 decimals)

### Charts & Refresh Strategy

- Multi-symbol fetch cadence is plan-aware (auto-set based on your subscription)
- In-memory time series buffer per metal (`/api/:metal/timeseries?limit=N`)
- One-time historical seed: 360 days via timeframe endpoint
- Lightweight SVG chart with minimal axes and date labels; values are the same units as the card; BRL card shows USD→BRL FX

### UI / Styling

- Dark theme with gradient background and sleek cards
- Per-metal accent colors on card headers (gold/silver/platinum/palladium/copper/nickel/cobalt)
- Inter font loaded from Google Fonts
- Locale-aware number formatting via `Intl.NumberFormat` for clean currency display
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

#### Configure refresh cadence by plan (Essential ~30m)

The server auto-sets refresh based on your plan, and you can override it.

- Supported plans (case-insensitive): `essential`, `basic`, `basicplus`, `professional`, `professionalplus`, `business`.
- Defaults used:
  - Essential: 30 minutes
  - Basic: 10 minutes
  - Basic Plus / Professional: 60 seconds
  - Professional Plus: 30 seconds
  - Business: 15 seconds

To configure via `.env`:

```
METALPRICE_PLAN=essential
# Optional manual override (minutes) – takes precedence over plan
# METALPRICE_REFRESH_MINUTES=30
```

5. Build and run
```bash
npm run build
npm run start
```

## Project Structure

- `src/config.ts` – Minimal `.env` loader and config exports
- `src/metalpriceClient.ts` – Tiny client for MetalpriceAPI `/latest`
- `src/server.ts` – Express server, routes, caching, static hosting
- `public/index.html` – Static UI (cards + mini charts; cards link to detail pages)
- `public/gold.html` – Gold detail page (line chart, timeframe/period controls)
- `public/silver.html`, `public/platinum.html`, `public/palladium.html`, `public/copper.html`, `public/nickel.html`, `public/cobalt.html` – Per‑metal detail pages mirroring gold, with correct units and axis formatting
- `scripts/fetchGold.ts` – CLI script used to verify initial integration
- `scripts/exportCobalt.ts` – Exports cobalt daily history to Excel (USD/ton and USD/lb)

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

## Future Enhancements (optional)

- Add 24h change using the `change` endpoint
- Multiple base currencies and a UI switcher
- Persisted caching (file or Redis) to survive restarts
- Small UI improvements (loading/error states)
- Detail pages: add OHLC when plan supports and unify area/line styles
- Shared JS module for detail charts to reduce duplication

## Detail Pages

Each metal card (except FX) links to a dedicated detail page under `/public` with:
- timeframe selector: 1y / 3y / 5y
- periodicity: daily / weekly / monthly (averaged)
- compact axes with month ticks; Y axis uses rounded steps per metal
- title shows the commodity name; a subtitle under the title shows the display unit (e.g., USD/oz, USD/lb, USD/ton)

Units per page:
- Gold, Silver, Platinum, Palladium: USD/oz
- Copper, Nickel: USD/lb (4 decimals)
- Cobalt: USD/ton (no decimals)

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

## Google Cloud Run (free tier)

Pre-reqs: `gcloud` CLI installed, a Google Cloud project (PROJECT_ID), billing enabled, and a regional Artifact Registry repo (REPO_NAME) created.

```bash
# Auth and defaults
gcloud auth login
gcloud config set project PROJECT_ID
gcloud config set run/region REGION

# Build local image
docker build -t dashboard:latest .

# Tag for Artifact Registry
docker tag dashboard:latest REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/dashboard:latest

# Login to Artifact Registry and push
gcloud auth configure-docker REGION-docker.pkg.dev
docker push REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/dashboard:latest

# Deploy to Cloud Run (allow unauthenticated)
gcloud run deploy dashboard \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/dashboard:latest \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars METALPRICE_API_KEY=$METALPRICE_API_KEY,METALPRICE_API_BASE=${METALPRICE_API_BASE:-https://api.metalpriceapi.com/v1},METALPRICE_PLAN=${METALPRICE_PLAN:-essential}

# Get URL
gcloud run services describe dashboard --format='value(status.url)'
```

You can also customize `cloudrun-service.yaml` and deploy via:

```bash
gcloud run services replace cloudrun-service.yaml
```


