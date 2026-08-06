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

## ⚠️ First: clean up the leftover rows

The 2026-08-05 run left roughly seven `C S324E` rows in the planner — each
failed timing round trip added one and then died before its cleanup. That leak
is fixed (cleanup now runs in a `finally`), but the existing rows are still
there. Re-paste the harness, then:

```js
const rows = await poc.readPlanner();
// Delete ONLY the C S324E rows this spike created. AFR305 (seq 999) and
// C S331 are yours — leave them.
for (const row of rows.filter((r) => r.key_course_id === "C S324E")) {
  await poc.testDelete(row);
}
await poc.readPlanner(); // confirm you're back to your real rows
```

Do this before any timing run — leftover rows change what the audit returns.

## DAP-122 — mostly done ✅

Confirmed on 2026-08-05 (recorded in
`docs/hypothetical-courses-design.md` § "Confirmed"):

| Question                   | Answer                                                      |
| -------------------------- | ----------------------------------------------------------- |
| Add via `page=4`           | Works, ~409 ms, `200` + redirect to `ut_course/`            |
| Delete via `action_code=D` | Works, ~259 ms, `200`, no redirect, exact row               |
| Duplicate add              | **Creates a duplicate row** — not a no-op                   |
| `key_course_seq`           | Counts **down** from 999 (999, 998, 997 …) — never hardcode |
| `key_course_id`            | dept+num, separator dropped: `C S` + `324E` → `C S324E`     |
| Nonexistent course         | No `page=4` link on `page=3`; no distinct error page        |
| Modify URL                 | Found — see below                                           |

**Modify** (discovered, not yet followed):

```text
/apps/degree/audits/planner/modify_planned_course/
  ?key_course_id=C S324E&key_course_ccyys=20272
  &key_course_seq=996&key_course_type=1&action_code=M
```

Still to do — open that URL in a real tab, change the term or pass/fail, submit,
and record from the Network tab what the browser actually sends. Note it carries
an extra `key_course_type` that delete doesn't, so modify's row key is a
**4-tuple**. DAP-129 needs the submit shape.

**Still open — planner limits (#6):**

```js
// Add rows one at a time until UT complains. Bail at ~15–20 if nothing does.
await poc.testAdd({ dept: "C S", num: "429H", ccyys: "20272" });
```

Record where you stopped rather than inventing a number, then `poc.cleanup()`.

Also still open: add a course for an **already-closed term** — does UT reject
it, or silently parenthesize it? (Parenthesized rows don't apply to audits, so
5.4 must treat them as sync failures.)

## Parallel adds (#8)

You asked whether planner writes can run concurrently. The design assumes a
serial queue; if parallel is safe, `syncPlannerTo()` could fan out instead.

```js
await poc.testParallelAdd([
  { dept: "C S", num: "324E", ccyys: "20272" },
  { dept: "C S", num: "331", ccyys: "20272" },
  { dept: "C S", num: "429H", ccyys: "20272" },
]);
await poc.cleanup();
```

It resolves all links first (read-only), then fires the `page=4` writes
together. Reports whether every row landed, and whether any two rows collided
on the same `key_course_seq`. **If `allLanded` is false or `duplicateSeq` is
true, UT needs serialized writes** — which settles the question for 5.2.

## Delete All — don't automate it

You asked about the `action_code=A` button. It's a plain GET, so yes, it would
work mechanically — UT's own button just does
`window.location.href = '...view_planner/?&action_code=A'` behind a
`confirm()`.

The harness deliberately doesn't call it, and 5.2 shouldn't either:

- **It deletes your real courses too.** Your planner has `AFR305` at seq 999
  that you didn't add through this spike. Delete All doesn't discriminate, and
  there's no undo — UT has no restore, so a mis-fire costs you real planning
  data.
- The design already rules it out ("Delete All = **never automated** —
  policy"), and the acceptance criteria require per-row user confirmation.
- Per-row delete is proven, fast (~259 ms), and precise. `poc.cleanup()` uses
  it, and it's what the leftover-row cleanup above relies on.

If you ever want it as a manual escape hatch, click UT's own button — that keeps
the `confirm()` dialog and a human in the loop, which is the whole safeguard.

## DAP-123 — what it's actually asking

Two questions that together decide **where the planner client lives**. Neither
is about the planner's behavior; both are about our extension's plumbing.

### Q1: Where can the planner code run?

A Chrome extension has two places to make requests, and they have different
powers:

|             | Content script (on a UT page)             | Background service worker                  |
| ----------- | ----------------------------------------- | ------------------------------------------ |
| Runs when   | Only while a UT tab is open               | Any time, no tab needed                    |
| Origin      | `utdirect.utexas.edu` — cookies automatic | Extension origin; needs `host_permissions` |
| `DOMParser` | Yes (it's a real page)                    | **No** — MV3 workers have no DOM           |

This matters because the whole preview flow is a background job — add, submit,
poll for ~seconds, scrape. If it must run in a content script, then **the user
closing that UT tab kills the preview mid-flight**, and 5.4 needs a
tab-lifetime strategy (there's already a known bug: the temp tab dies at 30 s
while the poll window is 90 s). If the worker can do it, the pipeline is far
simpler and more robust.

Everything you ran so far was in a **page console**, which is the
content-script case — so Q1's first half is already answered: it works there.
What's untested is the worker.

```js
await poc.testExecutionContext(); // you've effectively done this one
```

Now load the unpacked extension (`bun run dev`), open `chrome://extensions` →
Degree Audit + → **service worker**, paste `planner-poc.js` there, run the same
line. `host_permissions` for `utdirect.utexas.edu/*` is already in the manifest,
so the real questions are whether **cookies ride along** and whether parsing is
possible.

> Expect `domParserAvailable: false` — MV3 workers have no DOM. That alone
> doesn't settle it: if `cookiesRodeAlong` is true, the worker can fetch and
> hand the HTML to a content script or offscreen document to parse. A
> hybrid (fetch in worker, parse in page) may well be the answer.

### Q2: How do we know the session died?

Every planner write assumes a live session. If it's dead, we must stop _before_
writing — a half-completed preview leaves stray rows in a planner we can't
clean up. So we need a check that's cheap enough to run before every operation
and correct enough to trust.

```js
await poc.testAuthSignal(); // while logged IN — you have this data
```

Then log out (or use an incognito window) and run it again. Whichever field
flips most cheaply is the gate.

> **Your run already found a problem here.** The successful add returned
> `redirected: true`. Today
> [session.ts:39-46](../../features/session/session.ts#L39-L46) treats
> `response.redirected` as logged-out — which is fine for the read-only history
> probe it guards, but **would misread a successful planner add as a dead
> session.** That's the same bug that produced "Session died mid-add" in the
> harness. 5.2 must not reuse that check for writes. The logged-out capture
> tells us what to use instead.

## DAP-124 — preview round-trip timing (blocked → unblock it first)

The 2026-08-05 attempt produced **no timings at all**: every round trip died at
submit with `Request with GET/HEAD method cannot have body`. Two bugs, both now
fixed in the harness:

1. UT's audit form is a **GET** form — params must go in the query string, not
   a request body.
2. The harness grabbed the page's _first_ `<form>`, which is site search, not
   the audit form. That's why the Planned Courses checkbox came up missing.

**Step 1 — find the real form and checkbox:**

```js
await poc.dumpAuditForm(); // read-only; prints every form + field + label
```

Look through the output for the checkbox whose label mentions planned courses
and note its `name`.

**Step 2 — run the timing with that name:**

```js
await poc.timePreview({ dept: "C S", num: "324E", ccyys: "20272" }, 5, {
  plannedCheckboxName: "THE_NAME_YOU_FOUND",
});
```

Auto-discovery may now find it unaided (the form picker is fixed) — if so, you
can drop the third argument. Either way `submitPlannedAudit` now **throws
rather than silently submitting without the checkbox**, because a run that
excludes planned courses measures the wrong thing entirely.

Five full round trips: resolve → add → submit → poll raw history for the new ID
→ scrape → delete. Prints a `console.table` of p50/p95 per stage.

This creates **one real audit per run** in your UT history. Five is the ticket's
minimum; don't run many more. The harness now stops after 2 consecutive
failures instead of grinding through all five.

Watch for:

- **p95 total > 15 s** → flag on DAP-114. That reopens the eager-verify
  decision, which is the whole point of measuring.
- `addMs` includes the success redirect, since that's the real cost the
  production client pays — just don't read it as pure server time.

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

**"Request with GET/HEAD method cannot have body"** — fixed. UT's audit form is
a GET form; the harness was sending a POST body. See DAP-124 above.

**"Planned Courses checkbox not found"** — run `await poc.dumpAuditForm()` and
pass the name explicitly. The harness now refuses to submit without it rather
than quietly measuring a non-planned audit.

**Rows piling up after failed timing runs** — fixed. Cleanup now runs in a
`finally`, so a failure mid-round-trip still deletes that run's row. Rows from
before the fix must be removed manually (see the top of this file).

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
