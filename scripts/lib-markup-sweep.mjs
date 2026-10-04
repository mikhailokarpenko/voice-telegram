// Shared "is this service still API-only?" sweep for the admin-XSS guards.
//
// Why this exists: voice-phone and voice-telegram both serve JSON only today,
// so every escaping assertion in check-admin-xss.mjs is skipped and the guard
// is a no-op that prints OK forever. The only thing it can usefully assert in
// that state is that the API-only claim is still TRUE -- i.e. that a dashboard
// has not quietly come back. That assertion is the whole value of the guard in
// these repos, so it has to be hard to evade.
//
// The first version of the sweep looked only for `*.html` files and `.py`
// files containing `HTMLResponse(` or `text/html`, under `src/` only. Three
// ways to re-add a dashboard sailed straight past it (each verified green
// against that version before this library was written):
//
//   1. **Jinja templates.** `Jinja2Templates(...).TemplateResponse(...)` never
//      writes the string `HTMLResponse` or `text/html`, and the markup lives in
//      a `.html.j2` file the extension check did not recognise.
//   2. **`StaticFiles(directory="static", html=True)`.** The markup sits in a
//      top-level `static/` directory, *outside* `src/`, so the walk never saw
//      it; the mounting `.py` contains neither trigger string.
//   3. **`index.htm`** -- one character short of the only extension checked.
//
// All three serve an admin dashboard built from attacker-controlled call data
// (`From`/`To`/`CallSid` come off the inbound webhook) with zero escaping
// assertions anywhere in CI. So the sweep now walks the whole repo minus an
// explicit, *asserted* deny-list, knows the template extensions, and knows the
// template/static-mount APIs.
//
// `EXCLUDED_DIRS` is deliberately a frozen constant rather than an argument:
// quietly adding the directory you just put a dashboard in is the cheapest way
// to defeat this, so the guard asserts the set's exact contents and the
// mutation harness tries exactly that attack.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// Directories that are never shipped to a user's browser. Everything else in
// the repo is swept. Keep this minimal and justified; `assertExclusions()`
// pins it so a mutant cannot widen it.
export const EXCLUDED_DIRS = Object.freeze([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "docs",
  "migrations",
  "node_modules",
  "scripts", // the guards themselves necessarily contain these trigger strings
  "tests",
]);

// Markup and template file extensions. `.j2`/`.jinja`/`.jinja2` matter because
// `calls.html.j2` is a dashboard that the `.html`-only check could not see.
const MARKUP_EXT = [
  ".html",
  ".htm",
  ".xhtml",
  ".j2",
  ".jinja",
  ".jinja2",
  ".mustache",
  ".hbs",
  ".ejs",
];

// Python-side ways to start serving HTML. Each of these is an independent
// route back to a dashboard; missing any one of them reopens the hole.
const PY_HTML_SIGNALS = [
  { re: /HTMLResponse\s*\(/, why: "returns an HTMLResponse" },
  { re: /text\/html/, why: "sets a text/html media type" },
  { re: /TemplateResponse\s*\(/, why: "renders a server-side template" },
  { re: /Jinja2Templates\s*\(/, why: "configures Jinja2 templating" },
  { re: /StaticFiles\s*\([^)]*html\s*=\s*True/s, why: "mounts StaticFiles with html=True" },
  { re: /FileResponse\s*\([^)]*\.html/s, why: "serves an .html file directly" },
];

function isMarkupName(name) {
  const lower = name.toLowerCase();
  return MARKUP_EXT.some((ext) => lower.endsWith(ext));
}

/**
 * Walk `root` and return every file that looks like it serves markup.
 * @returns {{path: string, why: string}[]} repo-relative paths with a reason.
 */
export function sweepForMarkup(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: not a place a dashboard is served from
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.includes(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (isMarkupName(entry.name)) {
        found.push({ path: rel, why: "markup/template file" });
        continue;
      }
      if (!entry.name.endsWith(".py")) continue;
      let body;
      try {
        body = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const hit = PY_HTML_SIGNALS.find((s) => s.re.test(body));
      if (hit) found.push({ path: rel, why: hit.why });
    }
  };
  if (existsSync(root)) walk(root);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

/**
 * The deny-list is the sweep's only blind spot, so it is itself asserted.
 * Returns null when intact, or an error string describing the drift.
 */
export function assertExclusions(expected = EXCLUDED_DIRS) {
  const actual = [...EXCLUDED_DIRS].sort();
  const want = [...expected].sort();
  if (actual.length !== want.length || actual.some((v, i) => v !== want[i])) {
    const added = actual.filter((d) => !want.includes(d));
    const removed = want.filter((d) => !actual.includes(d));
    return (
      "EXCLUDED_DIRS drifted" +
      (added.length ? ` (+${added.join(", ")} — a dashboard hidden there would be invisible)` : "") +
      (removed.length ? ` (-${removed.join(", ")})` : "")
    );
  }
  return null;
}

// The list the guards pin against. Separate from EXCLUDED_DIRS on purpose:
// if someone edits EXCLUDED_DIRS they must also edit this, in a file whose
// whole subject is "do not widen the blind spot".
export const PINNED_EXCLUSIONS = Object.freeze([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "docs",
  "migrations",
  "node_modules",
  "scripts",
  "tests",
]);
