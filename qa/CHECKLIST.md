# Pre-Push Checklist

Walk through this before every push to `main`. Skip sections that aren't touched by the change.

## Universal gates (always)

- [ ] `npx tsc --noEmit` passes cleanly
- [ ] `git status` shows no unintended files staged (no `.env`, no `data/`, no `node_modules/`)
- [ ] Commit message describes the _why_, not just the _what_
- [ ] Diff scanned for stray `console.log`, debug code, hardcoded API keys

## If you changed `src/server.ts` or `src/metalpriceClient.ts`

- [ ] Type-checks pass
- [ ] Local `npm run dev` boots without errors
- [ ] `curl http://localhost:3000/health` returns `cacheWarm: true` within 30s
- [ ] `curl http://localhost:3000/api/allmetals/timeseries?limit=2` returns 12 symbols
- [ ] `curl http://localhost:3000/api/news` returns items (or `configured: false`)
- [ ] If you touched timeouts, log message wording, or refresh logic — verify `console.error` output renders as the structured JSON shape (`{severity, component, ...}`), not raw strings. Cloud Logging severity classification depends on this.
- [ ] If you touched the seed loop — verify locally that `seedComplete` flips to `true` AND `totalFailedChunks` is 0 AND the timeseries has points within the last 7 days

## If you changed `public/index.html`

**Producer ≠ Consumer rule applies.** Don't rely only on "the server returns the right thing." Verify what the browser actually renders.

- [ ] Hard-refresh (Cmd+Shift+R) the page locally — no console errors
- [ ] Hero card shows a number (not `—` or a skeleton)
- [ ] Each grid card has a price + sparkline
- [ ] News feed shows articles (or the unconfigured hint)
- [ ] If you touched chart logic — switch between 1D / 5D / 30D / 1Y / 3Y / ALL and confirm each renders without visual artifacts
- [ ] If you touched refresh/polling — open dev tools Network tab, wait the polling interval, confirm a new `/api/allmetals/timeseries` request fires automatically. **Do not skip this.**
- [ ] If you touched state — open the page in two tabs simultaneously; both should behave the same way

## If you changed `src/newsClient.ts` or news rendering

- [ ] All RSS feed URLs return 200 (run `qa/SMOKE-TESTS.md` § "News sources")
- [ ] An article with apostrophes or em-dashes renders correctly (no `&apos;`, no `&#8217;`)
- [ ] News timestamps say `2h ago` or `35m ago`, never showing the raw `pubDate` string

## If you changed the deploy workflow or Dockerfile

- [ ] Workflow YAML is syntactically valid (`gh workflow view deploy-cloud-run.yml`)
- [ ] No GitHub secret name is referenced that doesn't exist in repo settings
- [ ] Run a dry deploy first if possible
- [ ] After deploy, verify `/health` works AND a `/api/*` endpoint returns data — the deploy is "successful" even if the container fails to serve traffic

## Post-deploy verification (always)

- [ ] Wait for the deploy workflow to show `completed success`
- [ ] `curl https://dashboard-1056503697671.southamerica-east1.run.app/health` returns `cacheWarm: true`, `seedComplete: true`, `lastRefreshError: null`
- [ ] Open the production dashboard in a browser, hard-refresh, confirm prices render
- [ ] **Critical for data-flow changes**: leave the tab open for one full refresh interval (5 min by default) and verify the displayed price actually changes without you reloading

## Red-flag rule: producer-only confirmation is incomplete

If your verification step starts with "the server says...", "the API returns...", "the logs show...", you have NOT verified the user-facing behavior. Add a browser-side or end-to-end check.

Examples of incomplete verification:

- ❌ "lastRefreshAt is updating every 5 min" → does the rendered price update?
- ❌ "seedComplete: true with 1825 points" → does the 1Y chart show 1Y of data?
- ❌ "GET /api/news returns 30 items" → does the NewsFeed component show 30 cards?
- ❌ "Promise.race timer fires at 30s" → does the next periodic refresh succeed?

Add a check that closes the loop.
