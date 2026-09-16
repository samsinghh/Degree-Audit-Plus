import { fakeBrowser } from "@webext-core/fake-browser";
import type { CachedAuditData } from "@/domain/audit";

const SAMPLE_AUDIT_ID = "sample";

async function loadSampleAudit(): Promise<CachedAuditData> {
  const url = `${import.meta.env.BASE_URL}sample-audit.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Sample audit request failed with status ${response.status}`,
    );
  }
  return (await response.json()) as CachedAuditData;
}

async function seedSampleAudit() {
  const sample = await loadSampleAudit();
  await fakeBrowser.storage.local.set({
    auditHistory: {
      audits: [
        {
          auditId: SAMPLE_AUDIT_ID,
          title: "Sample Audit",
          majors: ["Computer Science"],
          // ut normally fills this from the history table so it is just a placeholder here
          percentage: 50,
        },
      ],
      timestamp: Date.now(),
    },
    [`auditData_${SAMPLE_AUDIT_ID}`]: sample,
  });
}

// storage has to be filled before the dashboard entry runs, or it sits on the loading page
await seedSampleAudit();
await import("@/entrypoints/degree-audit/main");
