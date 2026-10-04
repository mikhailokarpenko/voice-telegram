#!/usr/bin/env node
// Mutation audit harness for scripts/check-config-enums.mjs.
//
// A guard that has never been shown red proves nothing. Each mutant below
// removes one real control the way a refactor, a merge, or a "quick fix for
// the 422 someone complained about" would, and the guard must fail on it.
// Every file is restored afterwards; CI runs `git diff --exit-code` to prove
// the tree came back clean.
//
// SCOPE: only files inside THIS repo are mutated.
//
// Run: node scripts/test-config-enum-guard-mutants.mjs  (exit 0 = all caught)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts", "check-config-enums.mjs");

const ROUTES = ["src/voice_telegram/admin/routes.py", "src/voice_agent/admin/routes.py"]
  .map((rel) => join(root, rel))
  .find((p) => existsSync(p));

if (!ROUTES) {
  console.error("admin/routes.py not found; run from the repo root");
  process.exit(2);
}

const runGuard = () => {
  try {
    execFileSync(process.execPath, [guard], { stdio: "pipe", cwd: root });
    return true;
  } catch {
    return false;
  }
};

/** Body of the named @field_validator, for targeted surgery. */
const validatorRe = (field) =>
  new RegExp(`@field_validator\\(\\s*"${field}"\\s*\\)\\n(\\s*)@classmethod\\n\\s*def [\\s\\S]*?return normalized\\n`);

const mutants = [
  // ---- the original BAS-238 bug, in its exact historical form -------------
  [
    "the original bug: both fields are plain max_length strings again",
    (s) =>
      s
        .replace(validatorRe("openai_voice"), "")
        .replace(validatorRe("greeting_style"), ""),
  ],
  [
    "the voice validator is deleted (greeting still validated)",
    (s) => s.replace(validatorRe("openai_voice"), ""),
  ],
  [
    "the greeting_style validator is deleted (voice still validated)",
    (s) => s.replace(validatorRe("greeting_style"), ""),
  ],
  [
    "both validators are commented out (prose satisfies substring checks)",
    (s) =>
      s.replace(/@field_validator[\s\S]*?return normalized\n/g, (m) =>
        m.split("\n").map((l) => (l.trim() ? "    # " + l.trim() : l)).join("\n") + "\n",
      ),
  ],
  [
    "the validators survive only inside a docstring",
    (s) =>
      s
        .replace(validatorRe("openai_voice"), '    """validates openai_voice against VOICE_IDS, not in, raise ValueError"""\n')
        .replace(validatorRe("greeting_style"), '    """validates greeting_style against GREETING_STYLES, not in, raise ValueError"""\n'),
  ],

  // ---- validators present but neutered ------------------------------------
  [
    "voice validator never raises (logs and returns the bad value)",
    (s) =>
      s.replace(
        /if normalized not in VOICE_IDS:\n(\s*)raise ValueError\(\n[\s\S]*?\n\s*\)\n/,
        "if normalized not in VOICE_IDS:\n$1pass\n",
      ),
  ],
  [
    "greeting validator never raises",
    (s) =>
      s.replace(
        /if normalized not in GREETING_STYLES:\n(\s*)raise ValueError\(\n[\s\S]*?\n\s*\)\n/,
        "if normalized not in GREETING_STYLES:\n$1pass\n",
      ),
  ],
  [
    "voice validator drops the membership test (normalises only)",
    (s) =>
      s.replace(
        /if normalized not in VOICE_IDS:\n[\s\S]*?\n\s*\)\n/,
        "",
      ),
  ],
  [
    "greeting validator drops the membership test",
    (s) => s.replace(/if normalized not in GREETING_STYLES:\n[\s\S]*?\n\s*\)\n/, ""),
  ],
  [
    "voice validator consults no allowlist at all",
    (s) => s.replace(/not in VOICE_IDS/, "not in set()"),
  ],
  [
    "greeting validator consults no allowlist at all",
    (s) => s.replace(/not in GREETING_STYLES/, "not in set()"),
  ],

  // ---- allowlists themselves ----------------------------------------------
  ["VOICE_IDS is deleted", (s) => s.replace(/^VOICE_IDS\s*=.*\n/m, "")],
  ["GREETING_STYLES is deleted", (s) => s.replace(/^GREETING_STYLES\s*=.*\n/m, "")],
  [
    "VOICE_IDS is hand-copied instead of derived from AVAILABLE_VOICES (drifts from /voices)",
    (s) => s.replace(/^VOICE_IDS\s*=.*$/m, 'VOICE_IDS = frozenset({"ash", "alloy"})'),
  ],
  [
    "VOICE_IDS becomes a bare string (substring membership accepts 'as', 'sh', ...)",
    (s) => s.replace(/^VOICE_IDS\s*=.*$/m, 'VOICE_IDS = "ash alloy verse"'),
  ],
  [
    "GREETING_STYLES loses 'custom', 422ing the dashboard's own Custom Greeting option",
    (s) => s.replace(/"custom",?\s*/, ""),
  ],
  [
    "GREETING_STYLES loses 'casual', the default",
    (s) => s.replace(/frozenset\(\{"casual", /, 'frozenset({'),
  ],
  [
    "GREETING_STYLES is emptied (rejects every dashboard option)",
    (s) => s.replace(/^GREETING_STYLES\s*=.*$/m, "GREETING_STYLES = frozenset()"),
  ],

  // ---- wiring: the one-word edits that restore the bug silently -----------
  [
    "PUT /config binds the unvalidated field base instead of ConfigPayload",
    (s) => s.replace(/body:\s*ConfigPayload/, "body: ConfigFields"),
  ],
  [
    "ConfigResponse re-inherits ConfigPayload (GET /config 500s on legacy rows)",
    (s) => s.replace(/^class ConfigResponse\(\w+\)/m, "class ConfigResponse(ConfigPayload)"),
  ],
  [
    "ConfigPayload stops extending the field base (write/read models drift)",
    (s) => s.replace(/^class ConfigPayload\(\w+\)/m, "class ConfigPayload(BaseModel)"),
  ],
  [
    "ConfigResponse inherits a base that does not exist in the module",
    (s) => s.replace(/^class ConfigResponse\(\w+\)/m, "class ConfigResponse(SomeOtherBase)"),
  ],
  [
    "the decorator is detached from its function",
    (s) => s.replace(/@field_validator\(\s*"openai_voice"\s*\)\n\s*@classmethod\n\s*def \w+/, '@field_validator("openai_voice")\n    @classmethod\n    xdef _x'),
  ],
  ["class ConfigPayload is deleted entirely", (s) => s.replace(/^class ConfigPayload\([\s\S]*?(?=^class ConfigResponse)/m, "")],
  ["async def update_config is renamed away", (s) => s.replace(/def update_config/, "def update_config_disabled")],
];

const original = readFileSync(ROUTES, "utf8");

if (!runGuard()) {
  console.error("FATAL: guard is already red at HEAD; fix the tree before auditing the guard.");
  process.exit(2);
}

let caught = 0;
let escaped = 0;
let noop = 0;
try {
  for (const [name, mutate] of mutants) {
    const mutated = mutate(original);
    if (mutated === original) {
      console.error(`NO-OP   ${name}  <-- mutation did not change the file; the audit would pass vacuously`);
      noop++;
      continue;
    }
    writeFileSync(ROUTES, mutated);
    const green = runGuard();
    writeFileSync(ROUTES, original);
    if (green) {
      console.error(`ESCAPED ${name}`);
      escaped++;
    } else {
      console.log(`caught  ${name}`);
      caught++;
    }
  }
} finally {
  writeFileSync(ROUTES, original);
}

console.log(`\n${caught} caught, ${escaped} escaped, ${noop} no-op, ${mutants.length} total`);
if (escaped || noop) process.exit(1);
if (!runGuard()) {
  console.error("FATAL: tree not restored cleanly");
  process.exit(1);
}
console.log("config-enum guard mutation audit PASSED");
