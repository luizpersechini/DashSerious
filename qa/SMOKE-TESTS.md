# Smoke Tests — Concrete Commands

Run these against your local dev server and against production. Each test states the command, the expected output, and the failure signature.

Variables used:

```bash
LOCAL=http://localhost:3000
PROD=https://dashboard-1056503697671.southamerica-east1.run.app
```

---

## 1. Server boots and serves /health

```bash
curl -s $PROD/health | python3 -m json.tool
```

**Expected (steady-state, after seed has run):**

```json
{
  "ok": true,
  "cacheWarm": true,
  "cachedSymbols": 12,
  "seedComplete": true,
  "uptimeMs": <number>,
  "refresh": {
    "intervalMs": 300000,
    "lastRefreshAt": "<recent ISO timestamp>",
    "lastRefreshError": null,
    "nextRefreshAt": "<ISO timestamp ~5min in future>",
    "msSinceLastSuccess": <number under 360000>
  },
  "data": {
    "totalFailedChunks": 0,
    "oldestPoint": "<ISO ~5 years ago>",
    "newestPoint": "<ISO within last 10 minutes>"
  }
}
```

**Failure signatures:**

- `cacheWarm: false` after 60s of uptime → live refresh is stuck. Check `lastRefreshError`.
- `seedComplete: false` after 90s of uptime → seed is stuck. Watch `totalFailedChunks`.
- `lastRefreshError` non-null → upstream API failed; structured log in Cloud Logging has details.
- `oldestPoint` only a few days ago → seed didn't load the full SEED_DEPTH_DAYS window.
- `newestPoint` more than 10 min old → refresh has stalled despite no error.

---

## 2. All 12 symbols return data

```bash
curl -s "$PROD/api/allmetals/timeseries?limit=2" | python3 -c "
import json,sys
d=json.load(sys.stdin)
syms=d.get('symbols',{})
expected=['XAU','XAG','XPT','XPD','XCU','NI','XCO','BRL','BRENT','WTI','EUR','CAD']
for s in expected:
    pts=syms.get(s,[])
    flag='OK' if pts else 'MISSING'
    print(f'  {s:6s}  {flag}  pts={len(pts)}  latest={pts[-1][\"v\"] if pts else \"n/a\"}')
"
```

**Expected:** every symbol prints `OK`.

**Failure signature:** any `MISSING` → check the failing symbol against metalpriceapi directly to see if the API regressed.

---

## 3. Historical data covers the full SEED_DEPTH_DAYS window

```bash
curl -s "$PROD/api/allmetals/timeseries?limit=9999" | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin)
for sym in ('XAU','BRL','BRENT'):
    pts=d['symbols'][sym]
    oldest=datetime.datetime.utcfromtimestamp(pts[0]['t']/1000).strftime('%Y-%m-%d')
    newest=datetime.datetime.utcfromtimestamp(pts[-1]['t']/1000).strftime('%Y-%m-%d')
    print(f'  {sym}: {len(pts):4d} pts  {oldest} → {newest}')
"
```

**Expected:** ~1825 points per symbol (5 years default), oldest near today minus 5 years, newest within the last day.

**Failure signature:** if `newest` is more than ~7 days behind today, the most-recent seed chunk silently failed (a class of bug we've hit before — see KNOWN-BUGS.md).

---

## 4. /api gate returns 503 (not 200 with empty data) on cold cache

```bash
# Only meaningful in a brand-new container before the first refresh completes.
# Skip this test in steady state.
curl -s -w "\nHTTP %{http_code}\n" $PROD/api/gold/latest
```

**Expected on cold container:** HTTP 503, `Retry-After: 5` header, body `{"success":false,"error":"Cache warming up","retryAfterMs":5000}`.

**Failure signature:** HTTP 200 with empty/null data → gate is broken and frontend will render NaN.

---

## 4b. Periodic refresh actually fires (post-deploy regression check)

Within ~30 seconds of a fresh container starting, `lastRefreshAt` should be non-null. If it stays null forever despite `cacheWarm` being true (which can flip from on-demand handler calls), Cloud Run is silently CPU-throttling our background timers and `fetch` is stalling.

```bash
PROD=https://dashboard-1056503697671.southamerica-east1.run.app
for i in {1..8}; do
  curl -s --max-time 10 $PROD/health | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  up={int(d[\"uptimeMs\"]/1000)}s warm={d[\"cacheWarm\"]} lastSuccess={d[\"refresh\"][\"lastRefreshAt\"]} err={d[\"refresh\"][\"lastRefreshError\"]}')"
  sleep 10
done
```

**Expected by ~30s uptime:** `warm=True`, `lastSuccess=<recent ISO>`, `err=None`.

**Failure signature:** `lastSuccess=None` past 30s uptime, with `err="fetchLatest hard timeout (25000ms)"` → CPU throttling is back. Verify `--no-cpu-throttling` is still in the deploy workflow:

```bash
gcloud run services describe dashboard --region=southamerica-east1 \
  --format='value(spec.template.metadata.annotations."run.googleapis.com/cpu-throttling")'
# Expected: false
```

---

## 5. Refresh cadence (Producer side)

```bash
curl -s "$PROD/api/allmetals/timeseries?limit=20" | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin)
pts=d['symbols']['XAU'][-10:]
prev=None
for p in pts:
    ts=datetime.datetime.utcfromtimestamp(p['t']/1000)
    if prev:
        print(f'  {ts.strftime(\"%H:%M:%S\")}  gap={(ts-prev).total_seconds():.0f}s')
    else:
        print(f'  {ts.strftime(\"%H:%M:%S\")}  (first)')
    prev=ts
"
```

**Expected:** consecutive gaps within ±5s of the configured `METALPRICE_REFRESH_MINUTES × 60` (300s for 5min).

**Failure signature:** gap drift growing (300, 305, 318, 340 …) → API call duration eating into the interval (timer schedules from when previous completes, not from a fixed clock). Mostly cosmetic but worth investigating.

---

## 6. Refresh cadence (Consumer side) — THIS IS THE ONE WE KEEP MISSING

Open the dashboard in a browser. Note a price value and the wall-clock time.

```
Wait 6 minutes. Do NOT reload the page.
```

The displayed price should change (or stay equal if upstream didn't move). Open dev tools → Network tab → confirm that `GET /api/allmetals/timeseries` fired in the background without a manual reload.

**Failure signature:** Network tab shows no new request → frontend polling is broken (the May 27 bug).

Alternatively, force-test via dev tools:

```js
// In browser console, before the polling interval would naturally fire:
performance
  .getEntriesByType("resource")
  .filter((r) => r.name.includes("allmetals/timeseries")).length;
// Wait 6 minutes
performance
  .getEntriesByType("resource")
  .filter((r) => r.name.includes("allmetals/timeseries")).length;
// Second value should be > first.
```

---

## 7. Visibility-change refresh works

Open dev tools → Network. Switch to another tab for 30 seconds, then switch back to the dashboard.

**Expected:** a fresh `GET /api/allmetals/timeseries` fires within ~1 second of the tab regaining focus.

**Failure signature:** no request fired → the `visibilitychange` listener regressed.

---

## 8. News sources are alive

```bash
for url in \
  "https://www.mining.com/feed/" \
  "https://www.cnbc.com/id/19836768/device/rss/rss.html" \
  "https://newsdata.io/api/1/latest?q=gold&apikey=${NEWS_API_KEY}&language=en"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
    "$url")
  echo "  $code  $url"
done
```

**Expected:** all `200`.

**Failure signature:** any non-200 → that source has gone bad or is blocking our UA. See KNOWN-BUGS.md → "Kitco RSS 404."

---

## 9. metalpriceapi direct probe

```bash
curl -s "https://api.metalpriceapi.com/v1/latest?api_key=$METALPRICE_API_KEY&base=USD&currencies=XAU,XAG,XPT,XPD,XCU,NI,XCO,BRL,BRENT,WTI,EUR,CAD" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'success={d.get(\"success\")} rates_count={len(d.get(\"rates\",{}))}')
"
```

**Expected:** `success=True rates_count=24` (12 symbols × 2 forms each: raw + inverse).

**Failure signature:** `success=False` → API key or plan issue. `rates_count` < 24 → one or more symbols dropped from your plan tier.

---

## 10. Production URL is reachable from outside

```bash
curl -s -o /dev/null -w "HTTP %{http_code} %{time_total}s\n" $PROD/
```

**Expected:** HTTP 200 in under 2s.

**Failure signature:** anything else → Cloud Run service is down or the URL has changed.

---

## 11. History depth is intact (the axis the 2026-08 cap bug broke) — RUN AFTER EVERY DEPLOY

This is the automated guard for the point-cap history-eviction bug. `/health.history` grades every symbol's series depth against its expected floor and yields one boolean. Unlike the aggregate `data.oldestPoint` (a MIN across symbols — one symbol can lose its history invisibly), this is per-symbol.

```bash
curl -s "$PROD/health" | python3 -c "
import json,sys
h=json.load(sys.stdin)['history']
print('history.ok =', h['ok'], '  failing =', h['failing'])
for s,v in h['bySymbol'].items():
    flag='OK ' if v['ok'] else 'BAD'
    print(f'  {flag} {s:6s} pts={v[\"points\"]:5d} days={v[\"distinctDays\"]:5d} span={v[\"spanDays\"]:5d}d (min {v[\"expectedMinDays\"]}) oldest={v[\"oldest\"]}')
assert h['ok'], 'HISTORY DEPTH REGRESSION: ' + ','.join(h['failing'])
"
```

**Expected:** `history.ok = True`, `failing = []`. XAU/XAG/XPT/XPD/XCU/NI/BRL/EUR/CAD span ≈ 1,800d (5y); XCO/BRENT/WTI shorter (their upstream floors) but still `OK`. `points` should be only modestly above `distinctDays` (mostly daily + ≤3 days intraday) and well under 4,000.

**Failure signatures:**

- `ok=False`, some symbol `span` tiny with `oldest` = this week → **history evicted**. Check that `compactSeries` is still applied at all cap sites (`grep -n compactSeries src/server.ts` → live push ×3, seed pass, boot hydration).
- `points >> distinctDays` and `points` creeping toward 4,000 → intraday is filling the cap; compaction isn't running (retention window may have been widened, or a new push site bypasses `compactSeries`).
- One symbol `BAD` while others `OK` → that symbol's seed chunk failed silently or its `HISTORY_FLOORS` entry is wrong. Check `data.totalFailedChunks`.

**Why this exists:** the bug oscillated for weeks and hid behind re-seeding cold starts. Every "silent degradation" bug we fix must get a health signal for its axis — a fix without a signal is a patch that relies on a human remembering to check.

---

## How to use this file

For a typical change, run §1, §2, §6. For data-flow changes, also §3, §5 and **§11**. For news changes, §8. For deploy changes, all of the above. **§11 is mandatory after every production deploy** regardless of what changed.

If anything fails, **do not push.** Investigate, fix, re-run. If the failure is in production after your push, roll forward with another commit — don't leave broken state.
