#!/usr/bin/env node
// Guard: voice-telegram must stay API-only, or re-arm admin-XSS escaping
// assertions the moment it stops being.
//
// Why this repo needs a guard when it ships no HTML today:
//
// voice-telegram stores attacker-influenced call data -- the Telegram peer's
// identity, call ids, provider error strings -- in the `calls` table and serves
// it from the authenticated admin API (`GET /api/admin/calls`,
// `/api/admin/calls/{id}`). Today every one of those routes returns JSON via a
// pydantic `response_model`, so there is no HTML sink and nothing to escape.
// `src/voice_telegram/admin/static/` exists but is empty.
//
// That is a property of today's tree, not an invariant. voice-phone was in the
// identical position and the dashboard came back in voice-web with a weak
// escaper (`div.textContent = v; return div.innerHTML` does not encode quotes,
// so any value in a quoted attribute broke out). The moment a dashboard
// re-appears here, the stored call data becomes stored XSS in the admin's
// authenticated session -- and nothing in this repo's CI would have noticed,
// because voice-telegram had no admin-XSS guard of any kind.
//
// So this guard asserts the API-only claim rather than assuming it, and it
// fails loudly with instructions when that claim stops holding. It is the same
// ratchet as voice-phone's check-admin-xss.mjs skip path, sharing the same
// scripts/lib-markup-sweep.mjs.
//
// Run: node scripts/check-admin-xss.mjs   (exit 0 = still API-only)

import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepForMarkup, assertExclusions, PINNED_EXCLUSIONS } from "./lib-markup-sweep.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const failures = [];
const notes = [];
const check = (name, ok, detail = "") => {
  if (ok) notes.push(`  ok   ${name}`);
  else failures.push(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. the sweep's blind spot is pinned, behaviourally -------------------
// The deny-list is the only place the walk does not look, so widening
// EXCLUDED_DIRS to cover the directory you just put a dashboard in is the
// cheapest evasion. Checking assertExclusions() alone is insufficient: a mutant
// that widens the list AND stubs that function to `return null` passes. The
// skip set is therefore measured by observation.
const drift = assertExclusions(PINNED_EXCLUSIONS);
check(
  "the markup sweep's exclusion list has not been widened",
  drift === null,
  drift || "",
);

{
  const probeRoot = mkdtempSync(join(tmpdir(), "tg-xss-exclusions-"));
  try {
    const candidates = new Set(PINNED_EXCLUSIONS);
    const collect = (dir, depth) => {
      if (depth > 6) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        candidates.add(e.name);
        if (e.name === ".git" || e.name === "node_modules" || e.name === ".venv") continue;
        collect(join(dir, e.name), depth + 1);
      }
    };
    collect(repoRoot, 0);

    const skipped = [];
    for (const dir of candidates) {
      const probe = join(probeRoot, dir);
      mkdirSync(probe, { recursive: true });
      writeFileSync(join(probe, "index.html"), "<html><body><table></table></body></html>\n");
      if (sweepForMarkup(probeRoot).length === 0) skipped.push(dir);
      rmSync(probe, { recursive: true, force: true });
    }
    const observed = skipped.sort().join(", ");
    const pinned = [...PINNED_EXCLUSIONS].sort().join(", ");
    check(
      "the directories the sweep actually skips match the pinned list",
      observed === pinned,
      `observed [${observed}] != pinned [${pinned}] — a dashboard in an unpinned skipped directory is invisible`,
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

// ---- 2. the sweep can still find a dashboard ------------------------------
// Every assertion in part 3 is negative, so "found nothing" only means
// something if the sweep still finds the things it is supposed to find.
{
  const fx = mkdtempSync(join(tmpdir(), "tg-xss-selftest-"));
  try {
    const cases = {
      "src/pkg/index.html": "<html><body><table></table></body></html>\n",
      "src/pkg/legacy.htm": "<html><body><table></table></body></html>\n",
      "templates/calls.html.j2": "<html>{{ c.peer }}</html>\n",
      "src/pkg/render.py":
        'from fastapi.templating import Jinja2Templates\nt = Jinja2Templates(directory="templates")\n\n\ndef d(r):\n    return t.TemplateResponse("calls.html.j2", {"request": r})\n',
      "src/pkg/mount.py":
        'from fastapi.staticfiles import StaticFiles\n\n\ndef m(a):\n    a.mount("/admin", StaticFiles(directory="static", html=True))\n',
      "static/index.html": "<html><body><table></table></body></html>\n",
    };
    for (const [rel, body] of Object.entries(cases)) {
      const full = join(fx, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
    }
    const hits = sweepForMarkup(fx).map((h) => h.path.split(/[\\/]/).join("/"));
    for (const rel of Object.keys(cases)) {
      check(
        `the sweep can still detect ${rel}`,
        hits.includes(rel),
        `sweepForMarkup() missed it; the API-only verdict below means nothing. Found: ${hits.join(", ") || "(nothing)"}`,
      );
    }
    writeFileSync(join(fx, "src", "pkg", "service.py"), 'def handler():\n    return {"status": "ok"}\n');
    check(
      "the sweep does not flag an ordinary JSON handler",
      !sweepForMarkup(fx).some((h) => h.path.endsWith("service.py")),
      "sweepForMarkup() flags everything; it cannot distinguish a dashboard",
    );
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
}

// ---- 3. the actual claim --------------------------------------------------
const stray = sweepForMarkup(repoRoot);
const where = stray.map((f) => `${f.path} (${f.why})`).join(", ");
check(
  "voice-telegram is still API-only (no dashboard markup or template rendering anywhere in the repo)",
  stray.length === 0,
  "markup appeared at " +
    where +
    " — voice-telegram now has an HTML sink fed by stored call data. Port voice-web's " +
    "check-admin-xss.mjs escaping assertions (behavioural escaper tests + a whole-file " +
    "interpolation sweep via lib-html-sinks.mjs) and point them at the new file before merging.",
);

// The admin static dir is the most likely place for it to land; call it out
// separately so the failure names the path a reviewer will look at first.
const staticDir = join(repoRoot, "src", "voice_telegram", "admin", "static");
if (existsSync(staticDir)) {
  const contents = readdirSync(staticDir).filter((n) => n !== ".gitkeep" && n !== "__pycache__");
  check(
    "src/voice_telegram/admin/static/ is still empty",
    contents.length === 0,
    `now contains ${contents.join(", ")} — if this is a dashboard, see the previous assertion`,
  );
}

// A guard that asserts nothing passes forever. Counting assertions is not
// enough on its own: the sweep self-test alone contributes seven, so deleting
// the actual API-only claim left the guard comfortably over any threshold and
// still green. So the claim is identified by name, not just counted.
const CLAIM = "voice-telegram is still API-only";
check(
  "the API-only claim itself actually ran",
  [...notes, ...failures].some((l) => l.includes(CLAIM)),
  "the guard's one substantive assertion is gone; the remaining self-test only proves the sweep works, not that this repo is API-only",
);
check(
  "the run made substantive assertions (guard is not vacuously green)",
  notes.length + failures.length >= 8,
  "too few assertions ran; the sweep or the self-test was removed",
);

for (const line of notes) console.log(line);
if (failures.length) {
  console.error("\nadmin-XSS (API-only) guard FAILED:");
  for (const line of failures) console.error(line);
  process.exit(1);
}
console.log(
  `\nadmin-xss guard OK: ${notes.length} assertions passed; voice-telegram serves no HTML, so stored call data reaches no markup sink.`,
);
