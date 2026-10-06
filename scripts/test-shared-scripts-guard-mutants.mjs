#!/usr/bin/env node
// Mutation audit for scripts/check-shared-scripts.mjs.
//
// This guard pins the suite-wide shared guards against silent divergence. If it
// cannot go red, every copy can drift again and the manifest becomes decoration.
// Each mutant below reproduces one real divergence (the exact shape of the
// lib-py-blocks.mjs drift, a deleted shared file, a blanked digest, a missing or
// corrupt manifest, an unlisted shared library) and the guard must FAIL.
//
// A mutant that changes no file is reported NO-OP and never counted as caught.
// Every file is restored and the baseline re-checked green afterwards.
//
// Run: node scripts/test-shared-scripts-guard-mutants.mjs  (exit 0 = all caught)

import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(root, "scripts", "check-shared-scripts.mjs");
const MANIFEST = join(root, "scripts", "shared-scripts.manifest.json");

function runGuard() {
  try {
    execFileSync(process.execPath, [GUARD], { cwd: root, stdio: "pipe" });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

const baseline = runGuard();
if (!baseline.ok) {
  console.error("BASELINE IS RED -- the mutation audit would be meaningless.\n" + baseline.out);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const shared = Object.keys(manifest.files).sort();
// Mutate a REQUIRED entry: optional entries are allowed to be absent in a
// service that does not need them, so a deletion mutant on one of those is
// correct-to-pass and would be recorded as a false MISSED.
const isRequired = (f) => typeof manifest.files[f] === "string";
const required = shared.filter(isRequired);
if (required.length === 0) {
  console.error("manifest has no required shared entries; nothing to audit.");
  process.exit(1);
}
const firstLib = required.find((f) => f.startsWith("lib-")) ?? required[0];
const LIB = join(root, "scripts", firstLib);

// Each mutant: [name, [files it touches], apply()]
const mutants = [
  [
    `shared lib ${firstLib} hardened in one repo only (the real lib-py-blocks drift)`,
    [LIB],
    () =>
      writeFileSync(
        LIB,
        readFileSync(LIB, "utf8") +
          "\nexport function stripSomethingNewHere(src) { return src; }\n",
      ),
  ],
  [
    `shared lib ${firstLib} silently reverted to an older copy (one line removed)`,
    [LIB],
    () => {
      const lines = readFileSync(LIB, "utf8").split("\n");
      const i = lines.findIndex((l) => l.includes("export function"));
      lines.splice(i + 1, 1);
      writeFileSync(LIB, lines.join("\n"));
    },
  ],
  [
    `shared file ${firstLib} deleted from this repo while the others keep it`,
    [LIB],
    () => unlinkSync(LIB),
  ],
  [
    "a manifest digest blanked out (entry would otherwise enforce nothing)",
    [MANIFEST],
    () => {
      const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
      m.files[firstLib] = "";
      writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
    },
  ],
  [
    "a shared library dropped from the manifest (unlisted copy, free to drift)",
    [MANIFEST],
    () => {
      const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
      delete m.files[firstLib];
      writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
    },
  ],
  [
    "manifest emptied (guard would pass vacuously)",
    [MANIFEST],
    () => writeFileSync(MANIFEST, JSON.stringify({ files: {} }, null, 2) + "\n"),
  ],
  [
    "manifest corrupted",
    [MANIFEST],
    () => writeFileSync(MANIFEST, "{ not json"),
  ],
  [
    "manifest deleted",
    [MANIFEST],
    () => unlinkSync(MANIFEST),
  ],
];

let caught = 0;
let noop = 0;
let missed = 0;

for (const [name, files, apply] of mutants) {
  const saved = files.map((f) => [f, existsSync(f) ? readFileSync(f) : null]);
  apply();
  const changed = saved.some(([f, before]) => {
    const now = existsSync(f) ? readFileSync(f) : null;
    if (before === null || now === null) return before !== now;
    return !before.equals(now);
  });
  const res = runGuard();
  for (const [f, before] of saved) {
    if (before === null) {
      if (existsSync(f)) rmSync(f);
    } else {
      writeFileSync(f, before);
    }
  }
  if (!changed) {
    noop += 1;
    console.log(`NO-OP   ${name} (mutation changed nothing -- stale anchor, not counted)`);
    continue;
  }
  if (res.ok) {
    missed += 1;
    console.log(`MISSED  ${name}`);
  } else {
    caught += 1;
    console.log(`caught  ${name}`);
  }
}

const after = runGuard();
if (!after.ok) {
  console.error("TREE NOT RESTORED -- guard is red after the audit.\n" + after.out);
  process.exit(1);
}

console.log(`\n${caught}/${mutants.length} mutants caught (${noop} no-op, ${missed} missed).`);
if (missed > 0 || noop > 0) process.exit(1);
if (caught < mutants.length) process.exit(1);

// Vacuity floor: an emptied mutant list would otherwise report "0/0 caught"
// and exit 0, certifying a guard nothing ever tried to break.
const MIN_MUTANTS_EXECUTED = 8;
if ((caught + missed + noop) < MIN_MUTANTS_EXECUTED) {
  console.error(
    `FAIL - vacuity floor: only ${caught + missed + noop} mutants executed, but at least ` +
      `${MIN_MUTANTS_EXECUTED} are required.`,
  );
  process.exit(1);
}
