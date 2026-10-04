#!/usr/bin/env node
// Mutation audit harness for scripts/check-greeting-config.mjs.
//
// A guard that has never been shown red proves nothing. Each mutant below
// weakens one real control out of the tree -- the way a refactor, a merge, or
// a "temporary" debug edit would -- and the guard must fail. Every file is
// restored afterwards; CI runs `git diff --exit-code` to prove the tree came
// back clean.
//
// SCOPE: only files inside THIS repo are mutated.
//
// Run: node scripts/test-greeting-config-guard-mutants.mjs
//      (exit 0 = guard catches every mutant)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts", "check-greeting-config.mjs");

const FILES = {
  client: join(root, "src/voice_telegram/telegram/client.py"),
  config: join(root, "src/voice_telegram/config.py"),
  models: join(root, "src/voice_telegram/admin/models.py"),
  routes: join(root, "src/voice_telegram/admin/routes.py"),
};

const runGuard = () => {
  try {
    execFileSync(process.execPath, [guard], { stdio: "pipe", cwd: root });
    return true;
  } catch {
    return false;
  }
};

// [name, file-key, mutate]
const mutants = [
  // ---- the original BAS-234 bug, restored in its exact historical form -----
  [
    "the original bug: opening_message is intro_prompt and the resolver is gone",
    "client",
    (s) =>
      s
        .replace(
          /opening_message=build_opening_message\([\s\S]*?\n                \),\n/,
          "opening_message=(\n                    active_config.intro_prompt if active_config else self.settings.intro_prompt\n                ),\n",
        )
        .replace(/\ndef build_opening_message\([\s\S]*?\n\ndef append_transcript_turn/, "\n\ndef append_transcript_turn"),
  ],
  [
    "the resolver exists but is never called (defined-and-unused)",
    "client",
    (s) =>
      s.replace(
        /opening_message=build_opening_message\([\s\S]*?\n                \),\n/,
        "opening_message=(\n                    active_config.intro_prompt if active_config else self.settings.intro_prompt\n                ),\n",
      ),
  ],
  [
    "the resolver is deleted outright",
    "client",
    (s) => s.replace(/\ndef build_opening_message\([\s\S]*?\n\ndef append_transcript_turn/, "\n\ndef append_transcript_turn"),
  ],
  [
    "the resolver is commented out (prose satisfies substring checks)",
    "client",
    (s) =>
      s.replace(/^def build_opening_message\(([\s\S]*?)\n\ndef append_transcript_turn/m, (m) =>
        m
          .split("\n")
          .map((l) => (l.startsWith("def append_transcript_turn") || l === "" ? l : "# " + l))
          .join("\n"),
      ),
  ],
  [
    "the resolver body is stubbed to a constant",
    "client",
    (s) =>
      s.replace(
        /(\) -> str:\n)[\s\S]*?(\n\ndef append_transcript_turn)/,
        '$1    return "Hello."$2',
      ),
  ],

  // ---- the custom branch is present but cannot win -------------------------
  [
    "custom branch reads the field but returns the intro prompt anyway",
    "client",
    (s) => s.replace(/return custom_greeting\.strip\(\)/, "return intro_prompt.strip()"),
  ],
  [
    "custom branch is removed; only intro_prompt + synthesised fallback remain",
    "client",
    (s) =>
      s.replace(
        /    if greeting_style == "custom" and custom_greeting\.strip\(\):\n        return custom_greeting\.strip\(\)\n/,
        "",
      ),
  ],
  [
    'the "custom" sentinel is renamed, so the dashboard value never matches',
    "client",
    (s) => s.replace(/greeting_style == "custom"/, 'greeting_style == "__never__"'),
  ],
  [
    "precedence inverted: intro_prompt checked first (custom unreachable by default)",
    "client",
    (s) =>
      s.replace(
        /    if greeting_style == "custom" and custom_greeting\.strip\(\):\n        return custom_greeting\.strip\(\)\n    if intro_prompt\.strip\(\):\n        return intro_prompt\.strip\(\)\n/,
        '    if intro_prompt.strip():\n        return intro_prompt.strip()\n    if greeting_style == "custom" and custom_greeting.strip():\n        return custom_greeting.strip()\n',
      ),
  ],
  [
    "an unconditional early return shadows every branch",
    "client",
    (s) =>
      s.replace(
        /    if greeting_style == "custom" and custom_greeting\.strip\(\):/,
        '    return intro_prompt\n    if greeting_style == "custom" and custom_greeting.strip():',
      ),
  ],
  [
    "the synthesised fallback is replaced by an empty string (silent opening)",
    "client",
    (s) =>
      s.replace(
        /    style = \(greeting_style or "casual"\)[\s\S]*?\n    \)\n/,
        '    return ""\n',
      ),
  ],

  // ---- the call site stops reading one of the two sources of truth ---------
  [
    "the DB greeting_style is ignored; env always wins (dropdown decorative)",
    "client",
    (s) =>
      s.replace(
        /greeting_style=\(\n                        active_config\.greeting_style\n                        if active_config\n                        else self\.settings\.greeting_style\n                    \),/,
        "greeting_style=self.settings.greeting_style,",
      ),
  ],
  [
    "the env greeting_style fallback is dropped (crashes/ignores with no row)",
    "client",
    (s) =>
      s.replace(
        /greeting_style=\(\n                        active_config\.greeting_style\n                        if active_config\n                        else self\.settings\.greeting_style\n                    \),/,
        "greeting_style=active_config.greeting_style,",
      ),
  ],
  [
    "the DB custom_greeting is ignored; env always wins (textarea decorative)",
    "client",
    (s) =>
      s.replace(
        /custom_greeting=\(\n                        active_config\.custom_greeting\n                        if active_config\n                        else self\.settings\.custom_greeting\n                    \),/,
        "custom_greeting=self.settings.custom_greeting,",
      ),
  ],
  [
    "the env custom_greeting fallback is dropped",
    "client",
    (s) =>
      s.replace(
        /custom_greeting=\(\n                        active_config\.custom_greeting\n                        if active_config\n                        else self\.settings\.custom_greeting\n                    \),/,
        "custom_greeting=active_config.custom_greeting,",
      ),
  ],

  // ---- the resolved greeting is overwritten after the fact -----------------
  [
    "the resolved opening is overwritten by intro_prompt after construction",
    "client",
    (s) =>
      s.replace(
        /(\n            self\._bridge = RealtimeBridge\(self\.settings, session\))/,
        "\n            session.opening_message = self.settings.intro_prompt$1",
      ),
  ],

  // ---- the knobs themselves are quietly removed from a surface -------------
  [
    "greeting_style env setting deleted (knob half-removed)",
    "config",
    (s) => s.replace(/^\s*greeting_style: str = "casual"\n/m, ""),
  ],
  [
    "custom_greeting env setting deleted",
    "config",
    (s) => s.replace(/^\s*custom_greeting: str = ""\n/m, ""),
  ],
  [
    "greeting_style agent_configs column deleted",
    "models",
    (s) => s.replace(/^\s*greeting_style: Mapped\[str\][^\n]*\n/m, ""),
  ],
  [
    "custom_greeting agent_configs column deleted",
    "models",
    (s) => s.replace(/^\s*custom_greeting: Mapped\[str\][^\n]*\n/m, ""),
  ],
  [
    "greeting_style admin API field deleted",
    "routes",
    (s) => s.replace(/^\s*greeting_style: str = Field[^\n]*\n/m, ""),
  ],
  [
    "custom_greeting admin API field deleted",
    "routes",
    (s) => s.replace(/^\s*custom_greeting: str = ""\n/m, ""),
  ],
];

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]),
);

const restore = () => {
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, originals[k]);
};

if (!runGuard()) {
  console.error("BASELINE FAILED: the guard is red on an unmutated tree. Fix that first.");
  process.exit(1);
}

let caught = 0;
let escaped = 0;
let noop = 0;

for (const [name, key, mutate] of mutants) {
  const mutated = mutate(originals[key]);
  if (mutated === originals[key]) {
    // A mutant that did not change the file proves nothing and must not be
    // scored as caught -- that is how a harness silently rots into theatre.
    console.error(`  NO-OP  ${name} (pattern did not match ${key}; harness is stale)`);
    noop++;
    continue;
  }
  writeFileSync(FILES[key], mutated);
  const green = runGuard();
  restore();
  if (green) {
    console.error(`  ESCAPED ${name}`);
    escaped++;
  } else {
    console.log(`  caught  ${name}`);
    caught++;
  }
}

restore();

console.log(
  `\ngreeting-config guard mutation audit: ${mutants.length} mutants, ${caught} caught, ${escaped} escaped, ${noop} no-op`,
);
// --- vacuity floor (ratchet) ----------------------------------------------
// A harness whose mutant list is emptied -- or filtered to nothing by a stale
// anchor -- reports "0 caught" and exits 0: green while proving nothing. The
// floor counts mutants that ACTUALLY EXECUTED, so neither deleting entries nor
// short-circuiting the loop slips past it. It may only be raised.
const MIN_MUTANTS_EXECUTED = 22;
const _executed = caught + escaped + noop;
if (_executed < MIN_MUTANTS_EXECUTED) {
  console.error(
    `FAIL - vacuity floor: only ${_executed} mutants executed, but at least ${MIN_MUTANTS_EXECUTED} are required. ` +
      "Mutants were removed or skipped; this audit understates the guard's blind spots.",
  );
  process.exit(1);
}

if (escaped || noop) process.exit(1);
if (!runGuard()) {
  console.error("POST-RESTORE FAILED: tree not restored cleanly.");
  process.exit(1);
}
console.log("greeting-config guard mutation audit PASSED.");
