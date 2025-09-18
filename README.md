# Commodities Dashboard (MetalpriceAPI)

A minimal Node.js + TypeScript dashboard that shows live prices for several metals using MetalpriceAPI.

## Overview

- Backend: Express server that fetches MetalpriceAPI, caches results, and serves a small API + static page.
- Frontend: Simple static HTML page with cards for each metal.
- Data Provider: MetalpriceAPI (`/latest`) with API key auth.

## Features

- Per-metal endpoints with in-memory caching and periodic refresh (60s):
  - `GET /api/gold/latest`
  - `GET /api/silver/latest`
  - `GET /api/platinum/latest`
  - `GET /api/palladium/latest`
  - `GET /api/copper/latest`
  - `GET /api/nickel/latest` (symbol `NI`)
  - `GET /api/cobalt/latest`
- Unit handling
  - Precious metals (XAU, XAG, XPT, XPD): prices in USD/oz (troy) and internal conversion to USD/g
  - Others (XCU, NI, XCO): prices in USD/oz (avoirdupois) with USD/g
  - Copper and Nickel also expose USD/lb for convenience on the API, and UI shows USD/lb to 4 decimals
- Static page at `/` shows one price per metal:
  - Copper/Nickel: USD/lb (4 decimals)
  - Others: USD/oz (2 decimals)

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

5. Build and run
```bash
npm run build
npm run start
```

## Project Structure

- `src/config.ts` – Minimal `.env` loader and config exports
- `src/metalpriceClient.ts` – Tiny client for MetalpriceAPI `/latest`
- `src/server.ts` – Express server, routes, caching, static hosting
- `public/index.html` – Static UI
- `scripts/fetchGold.ts` – CLI script used to verify initial integration

## Notes & Decisions

- API key is kept server-side only; front-end calls local API.
- Nickel symbol is `NI` (confirmed via `/symbols` endpoint). UI label reflects `NI`.
- Conversions:
  - Troy ounce (precious): 31.1034768 g
  - Avoirdupois ounce: 28.349523125 g
  - Pound: 453.59237 g
- Refresh interval is set to 60 seconds by default.

## References

- MetalpriceAPI docs (auth, latest, symbols, units):
  - https://metalpriceapi.com/documentation

## Future Enhancements (optional)

- Add 24h change using the `change` endpoint
- Multiple base currencies and a UI switcher
- Persisted caching (file or Redis) to survive restarts
- Small UI improvements (loading/error states)


