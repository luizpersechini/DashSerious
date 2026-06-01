# Known Bugs — Chronological Log with Detection Recipes

Every bug we've shipped to production. Each entry includes the symptom, root cause, fix, and how to detect it next time. When you touch nearby code, scan this file for relevant detection recipes and add them to your smoke-test run.

---

## 2026-06-01 — Unexpected Cloud Run cost from always-on instance billing

**Symptom:** GCP cost spiked at the end of May (~R$24 net in May, billing chart flat until ~May 27 then jumping). A R$0.00 budget fired "100% reached." User correctly noted their usage hadn't changed.

**Root cause:** NOT usage — a billing-MODE change I introduced. `--min-instances 1` (added 2026-05-26, to avoid cold-start re-seed) plus `--no-cpu-throttling` (added 2026-05-28, to fix background-timer stalls) put Cloud Run into **instance-based billing**: CPU allocated and billed 24/7 regardless of traffic. The cost SKU was literally "Services CPU (Instance-based billing) in southamerica-east1." Run-rate ~R$5–10/day (~R$150–300/mo if left running).

**Fix:** reverted to `--min-instances 0` + `--cpu-throttling` (scale-to-zero, request-based billing → near-free). The original reason for the warm instance — avoiding the ~60s cold-start re-seed — is now moot because GCS persistence hydrates history from the bucket on boot. CRITICAL gotcha: `gcloud run deploy` retains unspecified flags, so you must set `--cpu-throttling` EXPLICITLY; merely removing `--no-cpu-throttling` leaves throttling off.

**Lesson:** `--min-instances ≥ 1` and `--no-cpu-throttling` are real recurring spend, not a rounding error. Don't reach for them to paper over a cold-start UX problem when persistence solves the root cause. Also: a R$0 budget makes the budget alert meaningless (fires on any spend) — set a real number.

**Detection recipe:**

```bash
# Cost reports → group by SKU. Watch for "Instance-based billing".
# Or check the deployed service config:
gcloud run services describe dashboard --region=southamerica-east1 \
  --format='value(spec.template.metadata.annotations."autoscaling.knative.dev/minScale", spec.template.metadata.annotations."run.googleapis.com/cpu-throttling")'
# Expect: minScale unset/0, cpu-throttling true (throttling ON = request billing).
```

**Files touched:** `.github/workflows/deploy-cloud-run.yml`, `test/smoke.test.ts`.

---

## 2026-06-01 — Ticker "not rendering" was actually "not scrolling" under Reduce Motion

**Symptom:** after the ticker was made an auto-scrolling marquee, the user reported it "not rendering" — first on localhost, then "not on prod." It looked identical to the old static bar.

**Root cause:** the bar WAS rendering full-width the whole time (confirmed in the user's real Chrome via the extension: viewport 1914px, 48 items). It just wasn't animating. The reduced-motion media query set `animation: none`, and the user's OS had **Reduce Motion enabled** (`matchMedia('(prefers-reduced-motion: reduce)').matches === true`). So the marquee was frozen.

**The localhost-vs-prod red herring:** the user's localhost was served by the dev server (live file edits, already had the fix), while prod ran the older deployed build. Same Reduce Motion setting on both — different code versions. Not a real environment discrepancy.

**Fix:** under reduced-motion, scroll gently (90s/loop) instead of `animation: none`. Set `--ticker-duration` in the `.ticker-track` CSS rule, NOT inline (inline custom properties outrank the media query and silently block the override). Normal motion = 60s.

**Why it was hard to see:** animations are paused in backgrounded/unfocused tabs and the headless preview, so `getComputedStyle(transform)` reads the start value forever. The reliable check is the Web Animations API.

**Detection recipe (in a focused real browser, via the Chrome extension or DevTools console):**

```js
const t = document.querySelector(".ticker-track");
const a = t.getAnimations()[0];
JSON.stringify({
  reduceMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  animationName: getComputedStyle(t).animationName, // must NOT be "none"
  duration: getComputedStyle(t).animationDuration, // 60s, or 90s under reduce-motion
  playState: a?.playState, // "running"
});
```

**Files touched:** `public/index.html` (CSS `.ticker-track` + reduced-motion media query).

---

## 2026-06-01 — NewsFeed duplicate React keys (cards dropped/duplicated, console flooded)

**Symptom:** console flooded with "Encountered two children with the same key" warnings from NewsFeed; news cards could be dropped or duplicated.

**Root cause:** cards were keyed on `item.id`, which the server computes as `base64(link).slice(0,16)` — identical for every URL starting with `https://www.` (base64 of that prefix is `aHR0cHM6Ly93d3cu`). Colliding keys.

**Fix:** key on `item.link + ":" + index` (link is unique). Frontend-only; didn't touch the server id.

**Detection recipe:** load the dashboard, open console — zero "same key" warnings. Or check `new Set(items.map(i=>i.id)).size === items.length` (will be false; that's why we key on link).

**Files touched:** `public/index.html` (NewsFeed `.map`).

---

## 2026-06-01 — CI test gate failed at `npm ci` (lockfile drift)

**Symptom:** the new CI `test` job failed immediately at install: "npm ci can only install packages when package.json and package-lock.json are in sync. Missing: esbuild@0.28.0 …". The gate worked (it skipped the deploy), but the gate itself was broken.

**Root cause:** the committed `package-lock.json` is intentionally NOT authoritative — it's reconciled per-platform at build time (the Dockerfile runs `npm install --package-lock-only` before `npm ci`). A cross-platform esbuild drift (vitest's nested esbuild) made plain `npm ci` reject it.

**Fix:** the test job mirrors the Dockerfile — `npm install --package-lock-only --no-audit --no-fund` then `npm ci`. Proven sequence (every Docker build uses it).

**Detection recipe:** the gate self-tests on every push; if install ever fails, this is the first thing to check. Locally: `rm -rf node_modules && npm ci` will reproduce the drift; `npm install --package-lock-only && npm ci` resolves it.

**Files touched:** `.github/workflows/deploy-cloud-run.yml`.

---

## 2026-05-28 — Hardcoded -$0.15/lb adjustment was making prices wrong, not right

**Symptom:** at some point earlier we noticed metalpriceapi copper/nickel values "didn't match TradingView/Kitco" and applied a `-0.15` subtract per pound. Carried for weeks before being questioned.

**Root cause / measurement:** sampled metalpriceapi against open public references on 2026-05-28:

| Symbol           | metalpriceapi raw | Stooq HG.F / Investing.com NI | Diff   |
| ---------------- | ----------------- | ----------------------------- | ------ |
| Copper (USD/lb)  | $6.3499           | $6.3423 (Stooq HG.F)          | +0.12% |
| Nickel (USD/ton) | $18,880           | $18,901 (Investing.com)       | −0.11% |
| Gold (USD/oz)    | $4,451            | $4,483 (Stooq GC.F)           | −0.71% |

All within 1%. The `-$0.15/lb` adjustment was ~2.4% — i.e. **pushing prices AWAY from market reality**, not toward it. Likely originated from comparing different contracts (LME cash vs 3-month vs COMEX) or a stale tab.

**Fix:** Two parts, both pushed 2026-05-28.

1. Removed the adjustment from `public/index.html` METALS array for XCU and NI. Prices now displayed as-is from metalpriceapi.

2. Added `src/calibrationClient.ts` — a calibration tracker that periodically samples Stooq CSV + Investing.com and records the diff vs metalpriceapi. Surfaces rolling diff per symbol on `/health` under `calibration.bySymbol`. The data is **measured, not applied** — if the diff ever drifts to a problematic level, you'll see it on `/health` and can decide what to do based on real numbers.

**Why this slipped through QA:** the adjustment was made eyeballing one moment's price comparison and never re-validated. Now: regression test in `test/smoke.test.ts` asserts the adjustment string is NOT in the bundled index.html, and the calibration block is present in `/health`.

**Detection recipe:**

```bash
PROD=https://dashboard-1056503697671.southamerica-east1.run.app
# Wait at least 30s after a fresh deploy for first calibration sample.
curl -s $PROD/health | python3 -c "
import json,sys
d=json.load(sys.stdin)
cal=d.get('calibration',{}).get('bySymbol',{})
for sym, data in cal.items():
    mean=data.get('meanDiffPct')
    n=data.get('samples',0)
    print(f'  {sym:6s}  samples={n}  meanDiffPct={mean:.2f}%' if mean is not None else f'  {sym:6s}  no samples yet')
"
```

**Expected:** every symbol's `meanDiffPct` within ±2%. If any symbol drifts beyond ±3% for sustained periods, investigate.

**Files touched:** `public/index.html`, `src/calibrationClient.ts` (new), `src/server.ts` (scheduler + /health), `test/smoke.test.ts` (regression).

---

## 2026-05-27 — Cloud Run CPU throttling stalled every periodic refresh

**Symptom:** on every fresh container, the scheduled periodic refresh hit `fetchLatest hard timeout (25000ms)` indefinitely. Manual curl to metalpriceapi: <1s. Manual `/api/gold/latest` against the same container: <1s. Only the background-timer-triggered fetch stalled. `lastRefreshAt` stayed `null` for the entire container lifetime; `cacheWarm` stayed `false`.

**Root cause:** Cloud Run's default behavior is CPU-throttle min-instance containers between requests. `--min-instances 1` keeps the container alive but throttles CPU when no request is in flight. Background `setTimeout` callbacks fire on the throttled CPU. `fetch()` starts the connection but data transfer stalls because the runtime has no CPU budget to drain the response stream. Manual requests don't see this because Cloud Run gives the container full CPU while a request is being processed.

**Fix:** added `--no-cpu-throttling` to the Cloud Run deploy. CPU is now continuously allocated to the min-instance. Cost increase: roughly +$10-20/mo at small-instance pricing — worth it to eliminate a class of latent failures.

**Also bundled:** `READY_TIMEOUT_MS` 10s → 30s (let the initial 25s hard-timeout actually complete before the seed proceeds), `RETRY_INTERVAL_MS` 60s → 15s (recover from any transient failure within seconds, not a full minute).

**Why this slipped through QA:** we kept verifying with manual curl, which always succeeded. The producer-side `/health` check showed cacheWarm/seedComplete=true _eventually_ (after the on-demand path we accidentally triggered while debugging) but `lastRefreshAt` was the smoking gun and got ignored. Detection now belongs in the periodic-refresh check, not just the cache-warm check.

**Detection recipe:**

```bash
# Wait for the FIRST periodic refresh to fire on a fresh container.
# If --no-cpu-throttling is missing OR something else stalls background
# tasks, lastRefreshAt stays null forever despite cacheWarm flipping true
# via on-demand triggers.
PROD=https://dashboard-1056503697671.southamerica-east1.run.app

# Right after a deploy completes, poll until uptime > intervalMs and
# verify lastRefreshAt is non-null AND lastRefreshError is null.
for i in {1..30}; do
  resp=$(curl -s --max-time 10 $PROD/health)
  up=$(echo "$resp" | python3 -c "import json,sys; print(int(json.load(sys.stdin).get('uptimeMs',0)/1000))")
  last=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('refresh',{}).get('lastRefreshAt'))")
  err=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('refresh',{}).get('lastRefreshError'))")
  echo "[$i] up=${up}s lastSuccess=$last err=$err"
  # Expect lastSuccess non-null by uptime ~30s. Expect err=None.
  sleep 15
done
```

Cloud Run service config check:

```bash
gcloud run services describe dashboard --region=southamerica-east1 \
  --format='value(spec.template.metadata.annotations."run.googleapis.com/cpu-throttling")'
# Should print: false  (cpu-throttling DISABLED = CPU always allocated)
```

If the annotation is missing or `true`, background timers will silently break.

**Files touched:** `.github/workflows/deploy-cloud-run.yml`, `src/server.ts` (timeout constants).

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
