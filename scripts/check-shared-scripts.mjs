#!/usr/bin/env node
// Shared-guard sync guard (voice suite).
//
// Several scripts/*.mjs are byte-identical copies carried by voice-phone,
// voice-telegram and voice-web: the shared libraries (lib-*.mjs) and the
// repo-agnostic guards built on them. Copies drift silently. That already
// happened once: voice-web grew `stripDocstrings()` in lib-py-blocks.mjs while
// the other two repos kept the older copy, so a guard hardened in one service
// stayed soft in the other two and nothing was red anywhere.
//
// The failure mode is specific to *security* guards: the weaker copy is the one
// that keeps passing, so divergence is invisible exactly when it matters.
//
// Enforcement: scripts/shared-scripts.manifest.json records the sha256 of every
// shared file. The manifest is itself a shared file, so all three repos must
// carry the identical manifest; updating one repo's copy of a shared guard
// without updating the other two makes those repos' CI red on the next run.
//
// Run: node scripts/check-shared-scripts.mjs   (exit 0 = in sync)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "scripts", "shared-scripts.manifest.json");
const failures = [];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

if (!existsSync(MANIFEST)) {
  console.error(
    "Shared-scripts guard FAILED:\n\n  - scripts/shared-scripts.manifest.json is missing; " +
      "without it the shared guards can diverge across the voice suite undetected.",
  );
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (e) {
  console.error(`Shared-scripts guard FAILED:\n\n  - manifest is not valid JSON: ${e.message}`);
  process.exit(1);
}

const files = manifest.files;
if (!files || typeof files !== "object" || Array.isArray(files)) {
  console.error("Shared-scripts guard FAILED:\n\n  - manifest has no `files` object mapping name -> sha256.");
  process.exit(1);
}

const names = Object.keys(files).sort();
if (names.length === 0) {
  failures.push("manifest lists no shared files; the guard would pass vacuously.");
}

// The manifest must pin itself through the list it publishes: every entry has
// to be a real 64-hex digest, so blanking a digest cannot turn a check into a
// no-op.
// An entry is either a bare digest (the file must exist in every service) or
// `{ sha, optional: true }` for guards only some services carry -- e.g. a
// Twilio-specific guard. Optional entries are still byte-pinned where present,
// so the "only two of three repos have it" case cannot drift either.
for (const name of names) {
  const entry = files[name];
  const want = typeof entry === "string" ? entry : entry && entry.sha;
  const optional = typeof entry === "object" && entry !== null && entry.optional === true;
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) {
    failures.push(`manifest entry "${name}" is not a sha256 digest; that entry enforces nothing.`);
    continue;
  }
  const p = join(root, "scripts", name);
  if (!existsSync(p)) {
    if (optional) continue;
    failures.push(
      `scripts/${name} is listed as a shared guard but is missing from this repo; the other services still ` +
        "carry it, so a control that exists suite-wide is absent here.",
    );
    continue;
  }
  const got = sha(readFileSync(p));
  if (got !== want) {
    failures.push(
      `scripts/${name} differs from the suite-wide copy (manifest ${want.slice(0, 12)}…, local ${got.slice(0, 12)}…). ` +
        "Either this repo's copy drifted, or it was hardened here and the other services were not updated. " +
        "Copy the intended version into all three repos and refresh shared-scripts.manifest.json everywhere.",
    );
  }
}

// Shared libraries are shared by construction: a lib-*.mjs that is not in the
// manifest is an unsynced copy waiting to drift.
const localLibs = readdirSync(join(root, "scripts")).filter((f) => /^lib-.*\.mjs$/.test(f));
for (const lib of localLibs) {
  if (!names.includes(lib)) {
    failures.push(
      `scripts/${lib} is a shared library but is not listed in shared-scripts.manifest.json; ` +
        "it can diverge from the other services unnoticed.",
    );
  }
}

if (failures.length > 0) {
  console.error("Shared-scripts guard FAILED:\n\n" + failures.map((f) => `  - ${f}`).join("\n\n"));
  process.exit(1);
}

console.log(`Shared-scripts guard OK: ${names.length} shared files match the suite-wide manifest.`);
