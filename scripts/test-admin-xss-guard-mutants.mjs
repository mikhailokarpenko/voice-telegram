#!/usr/bin/env node
// Mutation audit harness for scripts/check-admin-xss.mjs (voice-telegram).
//
// voice-telegram ships no HTML at all: every admin route returns JSON via a
// pydantic response_model, and src/voice_telegram/admin/static/ is empty. So
// this repo's guard has no escaping assertions to run -- its entire job is to
// assert that the API-only claim is still TRUE, and to fail with porting
// instructions the moment a dashboard comes back. That is exactly the shape of
// guard that rots silently, so every one of its negative assertions is
// mutation-tested here.
//
// Mutants are run against a disposable copy of the tree under the OS temp dir,
// not against this working tree, because the interesting mutants ADD whole
// source paths; this repo's tree is never touched.
//
// The escaping assertions themselves are mutation-tested where the dashboard
// actually lives: voice-web/scripts/test-admin-xss-guard-mutants.mjs.
//
// Run: node scripts/test-admin-xss-guard-mutants.mjs  (exit 0 = guard catches
// every mutant)
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guardSrc = readFileSync(join(root, "scripts", "check-admin-xss.mjs"), "utf8");
const sweepSrc = readFileSync(join(root, "scripts", "lib-markup-sweep.mjs"), "utf8");

// Build a disposable checkout that mirrors what CI actually sees: this repo
// alone, with no sibling voice-web beside it.
function makeSandbox() {
  const base = mkdtempSync(join(tmpdir(), "tg-admin-xss-mutants-"));
  const repo = join(base, "voice-telegram");
  mkdirSync(join(repo, "src", "voice_telegram"), { recursive: true });
  cpSync(join(root, "scripts"), join(repo, "scripts"), { recursive: true });
  return { base, repo };
}

function runGuardIn(repo) {
  try {
    execFileSync(process.execPath, [join(repo, "scripts", "check-admin-xss.mjs")], {
      stdio: "pipe",
      cwd: repo,
    });
    return true;
  } catch {
    return false;
  }
}

// [name, apply(repo)] -- each must make the guard go red.
const mutants = [
  ["a dashboard .html is re-added under src/ at a path PHONE does not name", repo => {
    writeFileSync(join(repo, "src/voice_telegram/dashboard.html"),
      `<html><body><table id="calls"></table></body></html>\n`);
  }],
  ["a dashboard is re-added in a NESTED directory (sweep must recurse)", repo => {
    mkdirSync(join(repo, "src/voice_telegram/admin/static"), { recursive: true });
    writeFileSync(join(repo, "src/voice_telegram/admin/static/index.html"),
      `<html><body><div id="rows"></div></body></html>\n`);
  }],
  ["a dashboard comes back as an inline HTMLResponse in a .py module", repo => {
    writeFileSync(join(repo, "src/voice_telegram/page.py"),
      `from starlette.responses import HTMLResponse\n\n\ndef page() -> HTMLResponse:\n    return HTMLResponse("""<html><body><table></table></body></html>""")\n`);
  }],
  ["a route starts serving text/html directly", repo => {
    writeFileSync(join(repo, "src/voice_telegram/legacy.py"),
      `BODY = "<html><body>%s</body></html>"\nMEDIA = "text/html"\n`);
  }],
  // The vacuity backstop: deleting the API-only claim must not leave a guard
  // that still prints OK off the back of its own self-test.
  ["the API-only claim is deleted, leaving only the sweep's self-test", repo => {
    const p = join(repo, "scripts", "check-admin-xss.mjs");
    const s = readFileSync(p, "utf8");
    const cut = s.replace(/const stray = sweepForMarkup\(repoRoot\);[\s\S]*?\n\);\n/, "");
    if (cut === s) throw new Error("could not locate the API-only claim");
    writeFileSync(p, cut);
  }],

  // ---- escapes of the ORIGINAL src/-only, .html-only, HTMLResponse-only
  // sweep. The first three were verified GREEN against that version before
  // lib-markup-sweep.mjs was written; each re-adds a real admin dashboard
  // built from attacker-controlled call data with no escaping assertions.
  ["dashboard returns via Jinja2 TemplateResponse (no HTMLResponse/text-html string)", repo => {
    mkdirSync(join(repo, "templates"), { recursive: true });
    writeFileSync(join(repo, "templates/calls.html.j2"),
      `<html><body><table>{% for c in calls %}<tr><td>{{ c.from_number }}</td></tr>{% endfor %}</table></body></html>\n`);
    writeFileSync(join(repo, "src/voice_telegram/dash.py"),
      `from fastapi.templating import Jinja2Templates\n\ntemplates = Jinja2Templates(directory="templates")\n\n\ndef dashboard(request):\n    return templates.TemplateResponse("calls.html.j2", {"request": request})\n`);
  }],
  ["dashboard mounted via StaticFiles(html=True) with markup OUTSIDE src/", repo => {
    mkdirSync(join(repo, "static"), { recursive: true });
    writeFileSync(join(repo, "static/index.html"),
      `<html><body><table id="calls"></table></body></html>\n`);
    writeFileSync(join(repo, "src/voice_telegram/mount.py"),
      `from fastapi.staticfiles import StaticFiles\n\n\ndef mount(app):\n    app.mount("/admin", StaticFiles(directory="static", html=True), name="admin")\n`);
  }],
  ["dashboard re-added as index.htm (one character off the checked extension)", repo => {
    writeFileSync(join(repo, "src/voice_telegram/index.htm"),
      `<html><body><table id="calls"></table></body></html>\n`);
  }],
  ["dashboard served by FileResponse('.../index.html')", repo => {
    writeFileSync(join(repo, "src/voice_telegram/serve.py"),
      `from fastapi.responses import FileResponse\n\n\ndef dashboard():\n    return FileResponse("assets/index.html")\n`);
  }],

  // ---- attacks on the sweep's own blind spot. The deny-list is the only
  // place the walk does not look, so widening it is the cheapest evasion.
  ["EXCLUDED_DIRS widened to hide the directory the dashboard was added to", repo => {
    mkdirSync(join(repo, "src/voice_telegram/ui"), { recursive: true });
    writeFileSync(join(repo, "src/voice_telegram/ui/index.html"),
      `<html><body><table id="calls"></table></body></html>\n`);
    const p = join(repo, "scripts", "lib-markup-sweep.mjs");
    const s = readFileSync(p, "utf8");
    const m = s.replace(/^(export const EXCLUDED_DIRS = Object\.freeze\(\[\n)/m, `$1  "ui",\n`);
    if (m === s) throw new Error("could not widen EXCLUDED_DIRS");
    writeFileSync(p, m);
  }],
  ["the markup extension list is narrowed back to .html only", repo => {
    writeFileSync(join(repo, "src/voice_telegram/index.htm"),
      `<html><body><table id="calls"></table></body></html>\n`);
    const p = join(repo, "scripts", "lib-markup-sweep.mjs");
    const s = readFileSync(p, "utf8");
    const m = s.replace(/const MARKUP_EXT = \[[\s\S]*?\n\];/, `const MARKUP_EXT = [".html"];`);
    if (m === s) throw new Error("could not narrow MARKUP_EXT");
    writeFileSync(p, m);
  }],
  ["the Python HTML-signal list is emptied (template rendering becomes invisible)", repo => {
    writeFileSync(join(repo, "src/voice_telegram/dash.py"),
      `from fastapi.responses import HTMLResponse\n\n\ndef dashboard():\n    return HTMLResponse("<html><body><table></table></body></html>")\n`);
    const p = join(repo, "scripts", "lib-markup-sweep.mjs");
    const s = readFileSync(p, "utf8");
    const m = s.replace(/const PY_HTML_SIGNALS = \[[\s\S]*?\n\];/, `const PY_HTML_SIGNALS = [];`);
    if (m === s) throw new Error("could not empty PY_HTML_SIGNALS");
    writeFileSync(p, m);
  }],
  ["sweepForMarkup() short-circuits to 'nothing found'", repo => {
    writeFileSync(join(repo, "src/voice_telegram/dashboard.html"),
      `<html><body><table id="calls"></table></body></html>\n`);
    const p = join(repo, "scripts", "lib-markup-sweep.mjs");
    const s = readFileSync(p, "utf8");
    const m = s.replace(/export function sweepForMarkup\(root\) \{\n/, "export function sweepForMarkup(root) {\n  return [];\n");
    if (m === s) throw new Error("could not short-circuit sweepForMarkup");
    writeFileSync(p, m);
  }],
  ["assertExclusions() always reports 'intact' while EXCLUDED_DIRS is widened", repo => {
    mkdirSync(join(repo, "src/voice_telegram/ui"), { recursive: true });
    writeFileSync(join(repo, "src/voice_telegram/ui/index.html"),
      `<html><body><table id="calls"></table></body></html>\n`);
    const p = join(repo, "scripts", "lib-markup-sweep.mjs");
    let s = readFileSync(p, "utf8");
    s = s.replace(/^(export const EXCLUDED_DIRS = Object\.freeze\(\[\n)/m, `$1  "ui",\n`);
    s = s.replace(/export function assertExclusions\(expected = EXCLUDED_DIRS\) \{\n/, "export function assertExclusions(expected = EXCLUDED_DIRS) {\n  return null;\n");
    writeFileSync(p, s);
  }],
];

const results = [];

// Baseline: the sandbox as CI sees it must be GREEN, else every mutant below
// is trivially "caught" and the audit is vacuous.
{
  const { base, repo } = makeSandbox();
  try {
    if (!runGuardIn(repo)) {
      console.error("FAIL - guard is red on the clean API-only sandbox; the audit would be vacuous");
      process.exit(1);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

for (const [name, apply] of mutants) {
  const { base, repo } = makeSandbox();
  try {
    apply(repo);
    results.push([name, runGuardIn(repo) ? "ESCAPED" : "caught"]);
  } catch (err) {
    results.push([name, `MUTATOR-ERROR (${err.message})`]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// The guard in THIS tree must be byte-identical to what we started with: the
// mutants only ever touched the sandbox.
if (readFileSync(join(root, "scripts", "check-admin-xss.mjs"), "utf8") !== guardSrc) {
  console.error("FAIL - the working tree's guard was modified; mutants must stay in the sandbox");
  process.exit(1);
}
if (readFileSync(join(root, "scripts", "lib-markup-sweep.mjs"), "utf8") !== sweepSrc) {
  console.error("FAIL - the working tree's lib-markup-sweep.mjs was modified; mutants must stay in the sandbox");
  process.exit(1);
}
if (existsSync(join(root, "src", "voice_telegram", "dashboard.html"))) {
  console.error("FAIL - a mutant leaked into the working tree");
  process.exit(1);
}


// --- vacuity floor (ratchet) ----------------------------------------------
// A harness whose mutant list is emptied -- or filtered to nothing by a stale
// anchor -- reports "0/0 caught" and exits 0: green while proving nothing.
// That is the same "asserted nothing" defect the guards themselves exist to
// catch, one level up. The floor counts mutants that ACTUALLY EXECUTED, so
// neither deleting entries nor short-circuiting the loop can slip past it.
// It may only be raised. Lowering it is a deliberate reduction in coverage.
const MIN_MUTANTS_EXECUTED = 14;
if ((results.length) < MIN_MUTANTS_EXECUTED) {
  console.error(
    `FAIL - vacuity floor: only ${results.length} mutants executed, but at least ${MIN_MUTANTS_EXECUTED} are required. ` +
      "Mutants were removed or skipped; this audit understates the guard's blind spots.",
  );
  process.exit(1);
}
let bad = 0;
for (const [name, status] of results) {
  if (status === "caught") console.log(`ok   - caught: ${name}`);
  else { bad++; console.error(`FAIL - ${status}: ${name}`); }
}
console.log(`\n${results.length - bad}/${results.length} mutants caught; working tree untouched.`);
process.exit(bad ? 1 : 0);
