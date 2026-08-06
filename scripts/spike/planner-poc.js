/**
 * DAP-115 (5.1) POC harness — planner mechanics + preview timing.
 *
 * THROWAWAY SPIKE. Not imported by the extension, not typechecked, not shipped.
 * Delete once the findings land in docs/hypothetical-courses-design.md.
 *
 * Usage: open a logged-in https://utdirect.utexas.edu/apps/degree/audits/ tab,
 * paste this whole file into the DevTools console, then run (see RUNBOOK.md):
 *
 *   await poc.readPlanner()
 *   await poc.testAdd({ dept: "C S", num: "324E", ccyys: "20272" })
 *   await poc.testIdempotency({ dept: "C S", num: "324E", ccyys: "20272" })
 *   await poc.testDelete(key)
 *   await poc.testExecutionContext()
 *   await poc.testAuthSignal()
 *   await poc.timePreview({ dept: "C S", num: "324E", ccyys: "20272" }, 5)
 *   poc.report()
 *
 * Safety rules encoded here (from docs/hypothetical-courses-design.md):
 *   - page=4 is a state-changing GET. Never prefetched, never constructed by
 *     hand — always parsed from the page=3 listing.
 *   - action_code=A (Delete All) is never issued. Per-row deletes only.
 *   - Every mutation is recorded in poc.state.added so cleanup() can undo it.
 */

(() => {
  const BASE = "https://utdirect.utexas.edu/apps/degree/audits";
  const PLANNER_LIST = `${BASE}/planner/ut_course/`;
  const PLANNER_VIEW = `${BASE}/planner/view_planner/`;
  const HISTORY = `${BASE}/submissions/history/`;
  const NEW_AUDIT = `${BASE}/submissions/student_individual/`;

  const state = {
    added: [], // rows this session created, for cleanup()
    findings: {}, // question id -> answer, printed by report()
    timings: [], // one entry per timePreview() round trip
  };

  const log = (...args) => console.log("%c[poc]", "color:#bf5700", ...args);
  const warn = (...args) => console.warn("%c[poc]", "color:#bf5700", ...args);

  const now = () => performance.now();
  const record = (id, value) => {
    state.findings[id] = value;
    log(`finding ${id}:`, value);
    return value;
  };

  /** Credentialed GET returning a parsed document plus the raw response. */
  async function get(url) {
    const startedAt = now();
    const response = await fetch(url, { credentials: "include" });
    const text = await response.text();
    return {
      url,
      response,
      elapsedMs: now() - startedAt,
      doc: new DOMParser().parseFromString(text, "text/html"),
      text,
    };
  }

  /** The logged-out signal under test (DAP-123 step 5). */
  function looksLoggedOut({ response, doc }) {
    return (
      response.redirected ||
      !response.ok ||
      /login|idp\.utexas|shib/i.test(response.url) ||
      Boolean(doc.querySelector('input[type="password"]'))
    );
  }

  // ---------------------------------------------------------------- read path

  /**
   * Parse View Courses into row keys. The row key is the triple the delete URL
   * needs: (key_course_id, key_course_ccyys, key_course_seq).
   */
  async function readPlanner() {
    const page = await get(PLANNER_VIEW);
    if (looksLoggedOut(page)) throw new Error("Not logged in — log in first.");

    const rows = [];
    for (const link of page.doc.querySelectorAll('a[href*="action_code=D"]')) {
      const params = new URL(link.getAttribute("href"), PLANNER_VIEW)
        .searchParams;
      const id = params.get("key_course_id");
      if (!id) continue;

      // UT parenthesizes expired rows; those don't apply to audits, so the
      // production client must reject them as preview inputs.
      const rowText = link.closest("tr")?.textContent?.trim() ?? "";
      rows.push({
        key_course_id: id,
        key_course_ccyys: params.get("key_course_ccyys"),
        key_course_seq: params.get("key_course_seq"),
        expired: /\(.*\)/.test(rowText),
        rowText: rowText.replace(/\s+/g, " "),
        deleteHref: link.getAttribute("href"),
      });
    }

    log(`planner has ${rows.length} row(s)`, rows);
    record("planner.rowCount", rows.length);
    record(
      "planner.seqValues",
      [...new Set(rows.map((r) => r.key_course_seq))].join(","),
    );
    return rows;
  }

  /**
   * Find the exact page=4 add link for a course on the page=3 listing.
   * Returns the href verbatim — never reconstructed.
   */
  async function resolveAddLink({
    dept,
    num,
    ccyys,
    courseType = "1",
    level = "U",
  }) {
    const listUrl =
      `${PLANNER_LIST}?page=3&course_ccyys=${encodeURIComponent(ccyys)}` +
      `&course_pass_fail=&s_pf=&course_type=${courseType}` +
      `&dpt=${encodeURIComponent(dept)}&s_lvl=${level}`;

    const page = await get(listUrl);
    if (looksLoggedOut(page)) throw new Error("Not logged in — log in first.");

    const candidates = [
      ...page.doc.querySelectorAll('a[href*="page=4"]'),
    ].filter((link) => {
      const linkNum = new URL(
        link.getAttribute("href"),
        PLANNER_LIST,
      ).searchParams.get("course_num");
      return linkNum?.trim() === num.trim();
    });

    if (!candidates.length) {
      throw new Error(`No page=4 link for ${dept} ${num} in ${ccyys}`);
    }
    // More than one match means a topic course; the design says never pick one
    // silently, so surface the choice instead of guessing.
    if (candidates.length > 1) {
      warn(
        `${dept} ${num} has ${candidates.length} add links (topic course?) — pick one manually`,
        candidates.map((c) => c.getAttribute("href")),
      );
    }

    return {
      href: candidates[0].getAttribute("href"),
      listElapsedMs: page.elapsedMs,
      candidateCount: candidates.length,
    };
  }

  // --------------------------------------------------------------- write path

  /** Follow a parsed page=4 link. State-changing — only called deliberately. */
  async function followAddLink(href) {
    const page = await get(new URL(href, PLANNER_LIST).toString());
    if (looksLoggedOut(page)) throw new Error("Session died mid-add.");
    return page;
  }

  /**
   * DAP-122 steps 1: add a course and verify the row landed.
   * Records the new row so cleanup() can remove it.
   */
  async function testAdd(course) {
    const before = await readPlanner();
    const { href, candidateCount } = await resolveAddLink(course);
    log("resolved add link:", href);

    const startedAt = now();
    const addPage = await followAddLink(href);
    const after = await readPlanner();
    const addElapsedMs = now() - startedAt;

    const beforeKeys = new Set(before.map(rowKey));
    const newRows = after.filter((row) => !beforeKeys.has(rowKey(row)));

    record("add.works", newRows.length === 1);
    record("add.elapsedMs", Math.round(addElapsedMs));
    record("add.topicCandidates", candidateCount);
    record("add.responseStatus", addPage.response.status);

    state.added.push(...newRows);
    log(`add produced ${newRows.length} new row(s)`, newRows);
    return newRows[0];
  }

  /**
   * DAP-122 step 3: add the same course twice. Duplicate row or no-op?
   * Cleans up whatever the second add produced.
   */
  async function testIdempotency(course) {
    const before = await readPlanner();
    const { href } = await resolveAddLink(course);

    await followAddLink(href);
    const afterFirst = await readPlanner();
    await followAddLink(href);
    const afterSecond = await readPlanner();

    const delta1 = afterFirst.length - before.length;
    const delta2 = afterSecond.length - afterFirst.length;

    record(
      "add.idempotency",
      delta2 === 0
        ? "no-op (second add ignored)"
        : `duplicate row (+${delta2})`,
    );
    record("add.firstDelta", delta1);

    const beforeKeys = new Set(before.map(rowKey));
    const created = afterSecond.filter((row) => !beforeKeys.has(rowKey(row)));
    state.added.push(...created);
    return { delta1, delta2, created };
  }

  /** DAP-122 step 2: per-row delete. Never action_code=A. */
  async function testDelete(row) {
    if (!row) throw new Error("Pass a row from readPlanner()/testAdd().");

    const url =
      `${PLANNER_VIEW}?key_course_id=${encodeURIComponent(row.key_course_id)}` +
      `&key_course_ccyys=${encodeURIComponent(row.key_course_ccyys)}` +
      `&key_course_seq=${encodeURIComponent(row.key_course_seq)}` +
      `&action_code=D`;

    const before = await readPlanner();
    const startedAt = now();
    const page = await get(url);
    const after = await readPlanner();
    const elapsedMs = now() - startedAt;

    if (looksLoggedOut(page)) throw new Error("Session died mid-delete.");

    const removed = before.length - after.length;
    const targetGone = !after.some((r) => rowKey(r) === rowKey(row));

    record("delete.works", removed === 1 && targetGone);
    record("delete.elapsedMs", Math.round(elapsedMs));
    record("delete.removedExactlyOne", removed === 1);

    state.added = state.added.filter((r) => rowKey(r) !== rowKey(row));
    return { removed, targetGone };
  }

  /**
   * DAP-122 step 3: discover the Modify URL/form shape. Read-only — it only
   * reports the links/forms UT exposes for a row so we can name the params.
   */
  async function discoverModify() {
    const page = await get(PLANNER_VIEW);
    if (looksLoggedOut(page)) throw new Error("Not logged in — log in first.");

    const links = [...page.doc.querySelectorAll("a[href]")]
      .map((a) => a.getAttribute("href"))
      .filter((href) => /action_code=(?!D|A)|modify|page=5|page=6/i.test(href));

    const forms = [...page.doc.querySelectorAll("form")].map((form) => ({
      action: form.getAttribute("action"),
      method: form.getAttribute("method"),
      fields: [...form.elements].map((el) => ({
        name: el.name,
        type: el.type,
        value: el.value,
      })),
    }));

    record("modify.candidateLinks", links);
    record("modify.forms", forms);
    log("Inspect these, then follow the modify link manually in a tab.");
    return { links, forms };
  }

  // ------------------------------------------------- execution context + auth

  /**
   * DAP-123 step 4: does a planner GET work from the extension background
   * (no UT page origin) or only from a content script?
   *
   * Run this twice: once here (content-script/page context) and once from the
   * service-worker console (chrome://extensions → service worker → paste).
   * The two results together answer the ticket.
   */
  async function testExecutionContext() {
    const context =
      typeof window !== "undefined" && window.location?.hostname
        ? `page (${window.location.hostname})`
        : "worker/background";

    const page = await get(PLANNER_VIEW);
    const canParse = typeof DOMParser !== "undefined";
    const sawRows = Boolean(page.doc.querySelector('a[href*="action_code=D"]'));

    const result = {
      context,
      status: page.response.status,
      redirected: page.response.redirected,
      finalUrl: page.response.url,
      cookiesRodeAlong: !looksLoggedOut(page),
      domParserAvailable: canParse,
      parsedPlannerRows: sawRows,
    };
    record(`executionContext.${context}`, result);
    return result;
  }

  /** DAP-123 step 5: which signal detects logged-out most cheaply? */
  async function testAuthSignal() {
    const page = await get(HISTORY);
    const signals = {
      "response.redirected": page.response.redirected,
      "!response.ok": !page.response.ok,
      status: page.response.status,
      "response.url": page.response.url,
      "url !== requested": page.response.url !== HISTORY,
      "password input in DOM": Boolean(
        page.doc.querySelector('input[type="password"]'),
      ),
      elapsedMs: Math.round(page.elapsedMs),
      bytes: page.text.length,
    };
    record("auth.signalsWhileLoggedIn", signals);
    log(
      "Now log out (or open an incognito window) and re-run testAuthSignal() " +
        "to see which of these flips. The cheapest one that flips wins.",
    );
    return signals;
  }

  // ------------------------------------------------------------------- timing

  /** Raw history IDs, before the major+percentage dedupe the UI applies. */
  async function rawHistoryIds() {
    const page = await get(HISTORY);
    if (looksLoggedOut(page)) throw new Error("Not logged in — log in first.");

    const ids = [];
    for (const row of page.doc.querySelectorAll("table tbody tr")) {
      const cells = row.querySelectorAll("td");
      if (cells.length < 8) continue;
      const id = cells[6].querySelector("a")?.textContent?.trim();
      if (id) ids.push(id);
    }
    return { ids, elapsedMs: page.elapsedMs };
  }

  /**
   * Submit an audit with the Planned Courses checkbox set, by driving UT's own
   * form. Returns when the submit response comes back — generation continues
   * server-side, so the caller polls history for the new raw ID.
   */
  async function submitPlannedAudit() {
    const page = await get(NEW_AUDIT);
    if (looksLoggedOut(page)) throw new Error("Not logged in — log in first.");

    const form = page.doc.querySelector("form");
    if (!form) throw new Error("No audit form on the submit page.");

    const body = new URLSearchParams();
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) body.append(el.name, el.value || "on");
        continue;
      }
      if (el.type === "submit") continue;
      body.append(el.name, el.value ?? "");
    }

    // The Planned Courses checkbox is unchecked by default; our runs must
    // always set it. Find it by label text rather than a guessed name.
    const plannedInput = [
      ...form.querySelectorAll('input[type="checkbox"]'),
    ].find((input) => {
      const label =
        input.closest("label")?.textContent ??
        form.querySelector(`label[for="${input.id}"]`)?.textContent ??
        input.parentElement?.textContent ??
        "";
      return /planned/i.test(label);
    });

    if (!plannedInput) {
      warn("Could not find the Planned Courses checkbox — inspect the form.");
      record("submit.plannedCheckboxFound", false);
    } else {
      record("submit.plannedCheckboxFound", true);
      record("submit.plannedCheckboxName", plannedInput.name);
      body.set(plannedInput.name, plannedInput.value || "on");
    }

    const action = new URL(
      form.getAttribute("action") || NEW_AUDIT,
      NEW_AUDIT,
    ).toString();

    const startedAt = now();
    const response = await fetch(action, {
      method: (form.getAttribute("method") || "POST").toUpperCase(),
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    await response.text();
    return { elapsedMs: now() - startedAt, status: response.status };
  }

  /** Poll raw history until an ID appears that wasn't in `before`. */
  async function pollForNewAuditId(before, { windowMs = 90_000 } = {}) {
    const known = new Set(before);
    const startedAt = now();
    const deadline = startedAt + windowMs;

    while (now() < deadline) {
      const { ids } = await rawHistoryIds();
      const fresh = ids.find((id) => !known.has(id));
      if (fresh) return { auditId: fresh, elapsedMs: now() - startedAt };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`No new audit ID within ${windowMs}ms`);
  }

  async function scrapeAudit(auditId) {
    const startedAt = now();
    const page = await get(`${BASE}/results/${auditId}/`);
    if (looksLoggedOut(page)) throw new Error("Session died mid-scrape.");
    return {
      elapsedMs: now() - startedAt,
      // Rough proof the page really is an audit, without importing the parser.
      requirementRows: page.doc.querySelectorAll("tr").length,
    };
  }

  /**
   * DAP-124: one full preview round trip, per-stage. Adds the course, runs a
   * planned-inclusive audit, polls for the new raw ID, scrapes it, then
   * deletes the course again so the planner is left as found.
   */
  async function timeOnePreview(course) {
    const t = {};
    const total = now();

    // Snapshot first: cleanup below must only ever touch rows THIS run created.
    // Matching by course number alone would delete a pre-existing row for the
    // same course, which the ticket explicitly forbids.
    const before = await readPlanner();
    const beforeKeys = new Set(before.map(rowKey));

    const resolveStart = now();
    const { href } = await resolveAddLink(course);
    t.resolveMs = now() - resolveStart;

    const addStart = now();
    await followAddLink(href);
    const rows = await readPlanner();
    t.addMs = now() - addStart;

    const created = rows.filter((row) => !beforeKeys.has(rowKey(row)));
    if (created.length !== 1) {
      warn(
        `expected exactly 1 new row, got ${created.length} — not auto-deleting`,
        created,
      );
    }

    const beforeIds = (await rawHistoryIds()).ids;

    const submit = await submitPlannedAudit();
    t.submitMs = submit.elapsedMs;

    const polled = await pollForNewAuditId(beforeIds);
    t.generateMs = polled.elapsedMs;

    const scraped = await scrapeAudit(polled.auditId);
    t.scrapeMs = scraped.elapsedMs;

    // Clean up: remove exactly the row this run created (identified by the
    // before/after diff above, never by course-number matching).
    if (created.length === 1) {
      const added = created[0];
      const deleteStart = now();
      await get(
        `${PLANNER_VIEW}?key_course_id=${encodeURIComponent(added.key_course_id)}` +
          `&key_course_ccyys=${encodeURIComponent(added.key_course_ccyys)}` +
          `&key_course_seq=${encodeURIComponent(added.key_course_seq)}` +
          `&action_code=D`,
      );
      t.deleteMs = now() - deleteStart;

      const after = await readPlanner();
      if (after.length !== before.length) {
        warn(
          `planner not restored: ${before.length} rows before, ${after.length} after`,
        );
        state.added.push(added);
      }
    } else {
      // Leave the rows for cleanup() rather than guessing which to delete.
      state.added.push(...created);
    }

    t.totalMs = now() - total;
    t.auditId = polled.auditId;
    t.requirementRows = scraped.requirementRows;
    state.timings.push(t);
    log("round trip", t);
    return t;
  }

  /** Run N round trips back to back and print the p50/p95 table. */
  async function timePreview(course, runs = 5) {
    for (let i = 0; i < runs; i++) {
      log(`--- round trip ${i + 1}/${runs}`);
      try {
        await timeOnePreview(course);
      } catch (error) {
        warn(`round trip ${i + 1} failed:`, error);
      }
    }
    return timingTable();
  }

  function percentile(values, p) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.ceil((p / 100) * sorted.length) - 1,
    );
    return Math.round(sorted[index]);
  }

  function timingTable() {
    const stages = [
      "resolveMs",
      "addMs",
      "submitMs",
      "generateMs",
      "scrapeMs",
      "deleteMs",
      "totalMs",
    ];
    const table = {};
    for (const stage of stages) {
      const values = state.timings
        .map((t) => t[stage])
        .filter((v) => typeof v === "number");
      if (!values.length) continue;
      table[stage] = {
        n: values.length,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        min: Math.round(Math.min(...values)),
        max: Math.round(Math.max(...values)),
      };
    }
    console.table(table);

    const p95Total = table.totalMs?.p95;
    if (p95Total > 15_000) {
      warn(
        `p95 total ${p95Total}ms exceeds the 15s threshold — flag DAP-114; ` +
          "this reopens the eager-verify decision.",
      );
    }
    record("timing.table", table);
    return table;
  }

  // ------------------------------------------------------------------ cleanup

  const rowKey = (row) =>
    `${row.key_course_id}|${row.key_course_ccyys}|${row.key_course_seq}`;

  /** Delete every row this session added. Per-row only; never action_code=A. */
  async function cleanup() {
    if (!state.added.length) {
      log("nothing to clean up");
      return [];
    }
    const results = [];
    for (const row of [...state.added]) {
      try {
        results.push(await testDelete(row));
      } catch (error) {
        warn("cleanup failed for", row, error);
      }
    }
    const remaining = await readPlanner();
    log(`cleanup done — planner now has ${remaining.length} row(s)`);
    return results;
  }

  function report() {
    log("=== DAP-115 findings ===");
    console.log(JSON.stringify(state.findings, null, 2));
    if (state.timings.length) timingTable();
    if (state.added.length) {
      warn(
        `${state.added.length} row(s) still in the planner from this session — ` +
          "run poc.cleanup()",
      );
    }
    return state.findings;
  }

  globalThis.poc = {
    state,
    readPlanner,
    resolveAddLink,
    testAdd,
    testIdempotency,
    testDelete,
    discoverModify,
    testExecutionContext,
    testAuthSignal,
    rawHistoryIds,
    submitPlannedAudit,
    timeOnePreview,
    timePreview,
    timingTable,
    cleanup,
    report,
  };

  log(
    "ready — see scripts/spike/RUNBOOK.md. Start with: await poc.readPlanner()",
  );
})();
