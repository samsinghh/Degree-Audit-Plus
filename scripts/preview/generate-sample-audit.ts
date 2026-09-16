import { JSDOM } from "jsdom";
import path from "node:path";
import { parseAuditPage } from "../../features/audit-scraping/audit-page-parser";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const fixturePath = path.join(
  projectRoot,
  "tests/fixtures/scraping/audit-results-real.html",
);
const outputPath = path.join(projectRoot, "preview/public/sample-audit.json");

const html = await Bun.file(fixturePath).text();
const dom = new JSDOM(html);

// jsdom has no innerText so fall back to textContent like the scraper tests do
Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
  get() {
    return this.textContent ?? "";
  },
});

const originalLog = console.log;
console.log = () => {};
const audit = parseAuditPage(dom.window.document);
console.log = originalLog;

await Bun.write(outputPath, JSON.stringify(audit));

const courseCount = Object.keys(audit.courses).length;
console.log(
  `Wrote ${outputPath} (${courseCount} courses, ${audit.requirements.length} requirements)`,
);
