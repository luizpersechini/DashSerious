# QA Protocol — STOP, READ BEFORE PUSHING TO MAIN

Every push to `main` triggers a Cloud Run deploy that immediately serves production traffic. There is no staging. There is no rollback button — only "push another commit and wait 2 minutes." So the protocol below is the safety net.

## Mandatory pre-push protocol

For **any** change that touches `src/`, `public/`, or `.github/workflows/`:

1. **Read `qa/CHECKLIST.md` and tick every box that applies.**
2. **Run `qa/SMOKE-TESTS.md` locally** with `npm run dev` against the change.
3. **After the deploy lands, run `qa/SMOKE-TESTS.md` against production.**
4. **If the change concerns data flow, refresh cadence, or rendering** — verify the **consumer side** explicitly, not just the producer.

## The "producer ≠ consumer" rule

This is the failure mode that produced the May 27 stale-frontend incident. Verifying the producer side (server logs say it refreshed) does not verify the consumer side (browser displays the new data). Every data-flow change requires checking both ends.

Concrete examples:

| Producer claim                    | Consumer check                                             |
| --------------------------------- | ---------------------------------------------------------- |
| Server `lastRefreshAt` is current | Reload-free wait: does the displayed price tick?           |
| Server returns 12 symbols         | Browser receives 12 symbols and renders all of them        |
| Seed completed with 1825 points   | A 1Y chart actually shows points spanning 365 days         |
| News cache has 30 articles        | NewsFeed component displays 30 articles                    |
| ETag is set correctly             | Browser respects it (Network tab shows 304 on second load) |

## Bug history index

See `qa/KNOWN-BUGS.md` — every bug we've caught has a detection recipe. Run the relevant ones whenever you touch adjacent code.

## What goes in the QA files

- `qa/CHECKLIST.md` — pre-push gates, group-by-area
- `qa/SMOKE-TESTS.md` — concrete `curl` + browser steps with expected output
- `qa/KNOWN-BUGS.md` — chronological bug log + detection recipe per bug
