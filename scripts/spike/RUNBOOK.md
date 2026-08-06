# DAP-115 (5.1) POC runbook

Throwaway spike for [DAP-115](https://linear.app/longhorn-devs/issue/DAP-115/51-poc-planner-mechanics-preview-timing)
and its sub-issues DAP-122 / DAP-123 / DAP-124.

Everything here needs a **real authenticated UT session (SSO + Duo)**, so it
runs on your device, not in CI and not from an agent. `planner-poc.js` is the
harness; this file is the script you follow.

Delete `scripts/spike/` once the findings are folded into
`docs/hypothetical-courses-design.md`.

## Before you start

- Log in at <https://utdirect.utexas.edu/apps/degree/audits/>.
- **Screenshot the planner as-is** (View Courses). You need a before/after pair
  as proof, and you need to know which rows were already yours.
- Pick a throwaway course you don't mind appearing in UT's planner log — the
  planner is one global list per student and UT logs every change. Use a course
  you'd never actually plan, in the next semester's `ccyys` (e.g. `20272`).
- Note: `page=4` (add) and `action_code=D` (delete) are **state-changing GETs**.
  Don't re-run cells casually and don't let DevTools replay requests.

## Load the harness

Open DevTools on any `utdirect.utexas.edu` audits page, paste the whole of
`planner-poc.js` into the console, hit enter. It exposes `poc`.

```js
await poc.readPlanner(); // sanity check: prints existing rows + their keys
```

If that throws "Not logged in", your session is dead — re-auth and reload.

## DAP-122 — add/delete mechanics, Modify, idempotency, limits

```js
const course = { dept: "C S", num: "324E", ccyys: "20272" };

// 1. Add: resolves the page=3 listing, follows the exact page=4 link, verifies
//    a row appeared. Records the new row for cleanup.
const row = await poc.testAdd(course);

// 2. Delete: per-row action_code=D. Confirms exactly that row went away.
await poc.testDelete(row);

// 3a. Idempotency: adds the same course twice. Duplicate row, or no-op?
await poc.testIdempotency(course);
await poc.cleanup(); // removes whatever that created

// 3b. Modify: read-only discovery of the URL/form shape.
await poc.discoverModify();
```

`discoverModify()` only lists candidate links and forms — follow the modify link
manually in a real tab, change term or pass/fail, and note in the console what
URL the browser actually hits (Network tab, "Copy link address"). That's the
shape DAP-129 needs.

**Error responses and limits** — do these by hand, they're judgment calls:

- Resolve a course number that doesn't exist in that dept/term. What does
  `page=3` render? (`resolveAddLink` will throw — read the thrown message.)
- Add a course for a term that's already closed. Does UT reject or silently
  parenthesize it?
- Keep adding rows until UT complains, to find the max. **Bail out** at ~15–20
  rows if nothing happens; don't spam the planner log chasing a limit that may
  not exist. Record where you stopped rather than a fake number.

Then `await poc.cleanup()` and re-screenshot the planner. It must match the
before screenshot exactly.

## DAP-123 — execution context + auth signal

Two contexts, same call:

```js
await poc.testExecutionContext(); // in a UT page console
```

Then load the unpacked extension (`bun run dev`), open
`chrome://extensions` → Degree Audit + → **service worker**, paste
`planner-poc.js` there, and run the same line. The host permission for
`https://utdirect.utexas.edu/*` is already in the manifest, so the interesting
question is whether cookies ride along and whether `DOMParser` exists in MV3's
worker — the result object reports both.

> Expect `domParserAvailable: false` in the service worker (MV3 has no DOM).
> That alone doesn't settle it: the fetch may still work, in which case the
> planner client can fetch in the background and parse elsewhere. Record what
> you actually see, not what you expect.

Auth signal:

```js
await poc.testAuthSignal(); // while logged IN
```

Then log out (or open an incognito window with the extension allowed) and run it
again. Whichever field flips most cheaply is the gate.
[session.ts:39-46](../../features/session/session.ts#L39-L46) already uses
`response.ok && !response.redirected` — this test either confirms that or
replaces it.

## DAP-124 — preview round-trip timing

```js
await poc.timePreview({ dept: "C S", num: "324E", ccyys: "20272" }, 5);
```

Five full round trips: resolve → add → submit (Planned Courses checked) → poll
raw history for the new ID → scrape → delete. Prints a `console.table` of
p50/p95 per stage.

This creates **one real audit per run** in your UT history. Five is the ticket's
minimum; don't run many more than that.

Watch for:

- `submit.plannedCheckboxFound: false` in the log — the form-field discovery
  missed the checkbox, and the timings are then measuring a non-planned audit.
  Inspect the form and fix the selector before trusting any numbers.
- **p95 total > 15 s** → flag on DAP-114. That reopens the eager-verify
  decision, which is the whole point of measuring.

## Troubleshooting

**"Session died mid-add" / "mid-delete"** — fixed. The old auth guard treated
`response.redirected` as logged-out, but UT's `page=4` and `action_code=D`
endpoints _redirect on success_, so a working add aborted with a scary error
after already writing the row. Mutations now report all auth signals and let
the planner before/after diff decide the outcome. If you loaded the harness
before this fix, re-paste it — and check View Courses for rows the aborted runs
left behind.

**Add reports 0 new rows** — either UT rejected it or the course was already
planned. Check `add.responseSignals` in the console for what UT actually
returned; that's also raw material for DAP-123.

## Finish

```js
poc.report(); // full findings JSON + timing table
await poc.cleanup(); // must leave the planner exactly as you found it
```

Then:

1. Paste the timing table + findings as a comment on DAP-115.
2. Check off the boxes in `docs/hypothetical-courses-design.md`
   § "Remaining unknowns" with the real answers.
3. Attach the before/after planner screenshots to the ticket.
4. Delete `scripts/spike/`.
