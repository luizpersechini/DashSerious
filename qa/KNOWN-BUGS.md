# Known Bugs — Chronological Log with Detection Recipes

Every bug we've shipped to production. Each entry includes the symptom, root cause, fix, and how to detect it next time. When you touch nearby code, scan this file for relevant detection recipes and add them to your smoke-test run.

---

## 2026-05-27 — Frontend never re-fetches; open tabs go stale forever

**Symptom:** dashboard showed prices that hadn't moved in hours even though the server was refreshing every 5 min. Reload made it work.

**Root cause:** `useEffect` in App had empty deps `[]`. `loadData()` ran once on mount, then never again. The server-side 5-min refresh was completely invisible to any browser already on the page.

**Fix:** added `setInterval` for prices (5min) and news (15min) + a `visibilitychange` listener that refreshes on tab-focus. Cleanup handlers return from the effect.

**Why this slipped through QA:** the verifier checked the **producer side only**. `/health` showed `lastRefreshAt` updating cleanly every 5 min, so the conclusion was "refresh is working." Nobody checked whether the rendered DOM updated.

**Detection recipe:**

```
1. Open the dashboard, note a price + the current wall-clock time
2. Wait 6 full minutes WITHOUT reloading the page
3. Verify either the price changed OR a new fetch fired in dev tools Network tab
```

Equivalent programmatic check via dev tools console:

```js
const count = () =>
  performance
    .getEntriesByType("resource")
    .filter((r) => r.name.includes("/api/allmetals/timeseries")).length;
const before = count();
// wait 6 minutes
const after = count();
console.assert(after > before, "frontend did not refresh");
```

**Files touched:** `public/index.html` — the App's main `useEffect`.

---

## 2026-05-27 — Chart "1Y" view showed ~1.5 days of intraday clustered at the right edge

**Symptom:** the 1Y, 3Y, and ALL charts had a near-flat tail at the right edge. Looked like prices froze in the last day.

**Root cause:** `getPoints(data, symbol, days)` used `array.slice(-days)` which takes the last N **array entries**, not the last N **days**. With 5-min live refresh adding ~288 entries/day, "1Y" became "the last ~36 hours." Plus, even after fixing the filter, the density mismatch (daily seed points before today, 288 intraday points today) visually compressed today's range into a tight horizontal line.

**Fix:** filter by real time window (`newest_t - days × 86_400_000`) AND downsample to one-point-per-UTC-day for windows ≥ 30 days. 1D and 5D keep intraday detail.

**Detection recipe:**

```
1. Switch the dashboard to 1Y view
2. Confirm the leftmost point on the chart is ~365 days ago, not ~36 hours ago
3. Confirm no visible "flat tail" anywhere
4. Switch to 3Y; verify the curve extends back ~3 years smoothly
5. Switch back to 1D; verify intraday volatility is preserved
```

**Files touched:** `public/index.html` — `getPoints()` function.

---

## 2026-05-27 — Seed silently failed to load the most recent year

**Symptom:** `seedComplete: true`, `totalFailedChunks: 0`, but the timeseries' `newestPoint` was a year stale. Once the chart filter bug was fixed (above), the missing data became visible.

**Root cause:** `await ready` in seedHistory caused the initial live refresh to add a single intraday point to the timeseries BEFORE the seed ran. The seed's `hasData=true` branch then computed `oldestMs`/`newestMs` from that one point, took the backfill+topup path, but the most-recent chunk silently failed to ingest (cause never pinned — possibly empty rates from upstream race, possibly chunk-ordering, possibly something else).

**Fix:** removed the hasData/backfill+topup dual path entirely. Seed always fetches the full range; dedupe handles overlap. Also added empty-rates detection: if a chunk returns `success: true` but inserts 0 points, increment `totalFailedChunks` with a WARNING log.

**Detection recipe:**

```bash
# After the seed completes, verify the newest point is within the last 7 days:
curl -s "$PROD/api/allmetals/timeseries?limit=9999" | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin)
pts=d['symbols']['XAU']
newest_ms=pts[-1]['t']
age_days=(datetime.datetime.utcnow().timestamp()*1000 - newest_ms) / 86400000
print(f'newest is {age_days:.1f} days old')
assert age_days < 7, 'seed did not load recent data'
"
```

**Files touched:** `src/server.ts` — `seedHistory` IIFE.

---

## 2026-05-26 — Initial refresh wedged the entire refresh singleton

**Symptom:** `cacheWarm: false` for >2 minutes after boot. Every `/api/*/latest` call returned 503. Both initial and subsequent periodic refreshes hung indefinitely.

**Root cause:** `AbortSignal.timeout(20000)` in undici (Node fetch) silently missed the response stream phase on a hung Cloud Run network connection. The fetch never aborted. The `inFlightRefresh` singleton in `coalesceRefresh` stayed pending forever, so every subsequent call returned the same dead promise.

**Fix:** added `withHardTimeout()` — a `Promise.race` against a manual `setTimeout` — to every `metalpriceClient` method. AbortSignal staying silent now reliably loses to the manual timer; the wrapper rejects, the singleton clears, the next refresh tries fresh.

**Detection recipe:**

```bash
# After deploy, monitor /health for the first 2 minutes:
PROD=https://dashboard-1056503697671.southamerica-east1.run.app
for i in {1..8}; do
  curl -s --max-time 10 $PROD/health | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  uptime={int(d[\"uptimeMs\"]/1000)}s cacheWarm={d[\"cacheWarm\"]} err={d[\"refresh\"][\"lastRefreshError\"]}')"
  sleep 15
done
# By poll 4 (uptime ~60s), cacheWarm should be true.
```

**Files touched:** `src/metalpriceClient.ts` — `withHardTimeout()` wrapper added to all three fetch methods.

---

## 2026-05-26 — fetchTimeframe 8s timeout silently broke the seed for 5 days

**Symptom:** every cold-start container's seed silently failed. Charts had no historical data. `totalFailedChunks` showed all chunks failing.

**Root cause:** commit `026a2cb` (May 21) added `AbortSignal.timeout(8000)` to all three metalpriceapi methods. Locally fast (<1s), but Cloud Run southamerica-east1 → metalpriceapi `/timeframe` with 12 symbols × 365 days routinely exceeded 8s. Every seed chunk AbortError-ed.

**Fix:** bumped `fetchTimeframe` to 60s, `fetchLatest`/`fetchChange` to 20s. Then later added the `withHardTimeout` backstop (above) for undici reliability.

**Detection recipe:**

After any timeout change, monitor a cold-start container's first 90 seconds:

```bash
# Watch totalFailedChunks during the seed window
for i in {1..6}; do
  curl -s $PROD/health | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  uptime={int(d[\"uptimeMs\"]/1000)}s seed={d[\"seedComplete\"]} failed={d[\"data\"][\"totalFailedChunks\"]}')"
  sleep 15
done
# Expected: seed=True with failed=0 by poll 4-5.
```

**Files touched:** `src/metalpriceClient.ts`.

---

## 2026-05-12 — Kitco RSS started returning 404 after their Next.js migration

**Symptom:** news feed showed fewer articles than usual; one source contributed zero items every refresh.

**Root cause:** `kitconews.rss` path stopped existing. No deprecation notice; the URL just 404'd silently. The RSS fetch soft-failed (returns `[]` on error), so the news feed kept working with two sources instead of three.

**Fix:** removed Kitco from `RSS_FEEDS` in `newsClient.ts`. Hardened CNBC's User-Agent to a full browser string in the same change (CNBC blocks bot-shaped UAs from GCP IPs).

**Detection recipe:** run `qa/SMOKE-TESTS.md` § 8 (News sources). Any feed returning non-200 needs investigation.

**Files touched:** `src/newsClient.ts`.

---

## 2026-05-26 — Hover state caused the left color-bar to disappear permanently

**Symptom:** mouse over a card → the colored left border disappeared and didn't come back when mouse left.

**Root cause:** the inline style had `border: '1px solid ...'` shorthand AND `borderLeft: '3px solid <metal-color>'`. The `border` shorthand briefly sets `border-left-color` to the shorthand's color before `borderLeft` overrides it. With `transition: 'border-color 0.15s'` on the element, the transition fired on that intermediate value and the override never visually applied.

**Fix:** replaced the shorthand with explicit `borderTop / borderRight / borderBottom` per card. `borderLeft` stays separate. CSS transition can't fight what's never overridden.

**Detection recipe:**

```
1. Hover each card type (hero, compact, news) for 1 second
2. Move mouse away
3. Confirm the colored left bar is back, full opacity
```

**Files touched:** `public/index.html` — HeroCard and CompactCard inline styles.

---

## 2026-05-26 — pubDate from NewsData.io showed 3h stale on UTC-3 dev machines

**Symptom:** "X hours ago" timestamps on articles consistently off by 3 hours in dev, correct in prod.

**Root cause:** NewsData.io returns `pubDate` as `"YYYY-MM-DD HH:MM:SS"` with no timezone marker. `Date.parse()` interprets that as local time. Dev machine in São Paulo (UTC-3) parsed the timestamp as UTC-3, Cloud Run in UTC parsed it as UTC. Result: 3h offset.

**Fix:** in `newsClient.ts`, replace the space with `'T'` and append `'Z'` before `Date.parse`. Forces UTC interpretation regardless of host timezone.

**Detection recipe:** every news article's `pubMs` should reflect the UTC publication time. After parsing, compare it to the original `pubDate` string — they should match if you format `pubMs` back to UTC.

**Files touched:** `src/newsClient.ts`.

---

## 2026-05-26 — Cloud Run cold-start blank-chart window (~2 min per deploy)

**Symptom:** for ~2 minutes after every deploy, users saw blank charts. Cleared up by itself.

**Root cause:** Cloud Run scales to zero between requests by default. Every deploy or idle scale-down created a new container with no `data/timeseries.json` (tmpfs is ephemeral). Seed ran from scratch, took 2 min, charts blank during that window.

**Fix:** added `--min-instances 1` to the deploy command. One container stays warm continuously. Cold starts now only happen on deploys, and we control deploy timing.

**Detection recipe:**

```bash
# Verify the running revision has min-instances ≥ 1:
gcloud run services describe dashboard --region=southamerica-east1 \
  --format='value(spec.template.metadata.annotations."autoscaling.knative.dev/minScale")'
# Should output: 1 (or higher)
```

**Files touched:** `.github/workflows/deploy-cloud-run.yml`.

---

## Template for new entries

```
## YYYY-MM-DD — One-line description

**Symptom:** what a user/operator saw

**Root cause:** the actual technical reason

**Fix:** what was changed

**Why this slipped through QA:** (only if applicable) what verification step missed it

**Detection recipe:** the exact command or steps that would have caught it

**Files touched:** path/to/file.ts
```

When adding an entry, also update `qa/CHECKLIST.md` and `qa/SMOKE-TESTS.md` if the detection recipe should become a permanent gate.
