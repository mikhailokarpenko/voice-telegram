#!/usr/bin/env node
// Guard: the configured greeting must actually be used.
//
// Why this exists (BAS-234):
//   `greeting_style` and `custom_greeting` have existed in this service as env
//   settings (config.py), columns on agent_configs (admin/models.py), validated
//   admin API fields (admin/routes.py) and a dropdown + textarea in the
//   voice-web dashboard. Nothing in the Telegram client read either one. The
//   opening message handed to the realtime provider was unconditionally
//   `intro_prompt`, so an operator who selected "custom" in the dashboard and
//   typed the greeting their brand requires changed a database row and nothing
//   audible. There was no error, no log line, and the admin API read the value
//   back verbatim -- the dashboard confirmed a setting that did not exist.
//
//   This is the same dead-config class as BAS-230 (`max_call_seconds`:
//   configurable in four places, enforced in none). A knob the API validates
//   and the runtime ignores is worse than no knob, because it reports a
//   behaviour that is not happening.
//
//   Note the precedence deliberately differs from voice-phone: there
//   `intro_prompt` is spoken over a separate Twilio <Say> channel so the
//   realtime opening is blanked when it is set. This client has one channel
//   only, so an explicit custom greeting must win over intro_prompt -- which is
//   exactly the case a naive "port the voice-phone branch" refactor gets wrong,
//   and which this guard pins.
//
// The guard is static (node-only, no Python/deps) so it runs in the `guards`
// CI job on every push.
//
// Run: node scripts/check-greeting-config.mjs   (exit 0 = safe)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyBlock, stripComments } from "./lib-py-blocks.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLIENT = "src/voice_telegram/telegram/client.py";
const CONFIG = "src/voice_telegram/config.py";
const MODELS = "src/voice_telegram/admin/models.py";
const ROUTES = "src/voice_telegram/admin/routes.py";

const failures = [];
const fail = (msg) => failures.push(msg);

const read = (rel) => {
  const p = join(repoRoot, rel);
  if (!existsSync(p)) {
    fail(`${rel} not found; guard must run from the repo root`);
    return null;
  }
  return readFileSync(p, "utf8");
};

const client = read(CLIENT);
const config = read(CONFIG);
const models = read(MODELS);
const routes = read(ROUTES);

// ---------------------------------------------------------------------------
// 1. The knobs must still exist on every surface that advertises them.
//    Deleting the setting is a legitimate decision, but it must be made on all
//    four surfaces at once; silently dropping one is how the config went dead.
// ---------------------------------------------------------------------------
for (const [rel, src, pat, what] of [
  [CONFIG, config, /^\s*greeting_style\s*:\s*str\s*=/m, "greeting_style env setting"],
  [CONFIG, config, /^\s*custom_greeting\s*:\s*str\s*=/m, "custom_greeting env setting"],
  [MODELS, models, /greeting_style\s*:\s*Mapped\[str\]/, "greeting_style agent_configs column"],
  [MODELS, models, /custom_greeting\s*:\s*Mapped\[str\]/, "custom_greeting agent_configs column"],
  [ROUTES, routes, /^\s*greeting_style\s*:\s*str\s*=/m, "greeting_style admin API field"],
  [ROUTES, routes, /^\s*custom_greeting\s*:\s*str\s*=/m, "custom_greeting admin API field"],
]) {
  if (src && !pat.test(src)) {
    fail(`${rel}: ${what} not found — if the greeting knobs are being removed they must be removed from config, model, admin API and the voice-web form together, not left half-present`);
  }
}

// Strip comments before every claim about the client: prose satisfies
// substring checks, and a commented-out resolver is precisely the regression
// this guard exists to catch.
if (client) {
  const code = stripComments(client);

  // -------------------------------------------------------------------------
  // 2. A real resolver must exist, as live code, with a non-trivial body.
  // -------------------------------------------------------------------------
  const resolver = pyBlock(code, "def", "build_opening_message");
  if (!resolver) {
    fail(`${CLIENT}: def build_opening_message(...) not found — the greeting configuration has no resolver and the opening message is whatever one hardcoded field happens to be`);
  } else {
    // Drop the signature and the docstring before asserting: parameter names
    // and prose both satisfy substring checks in a resolver whose code reads
    // neither knob.
    const sigEnd = resolver.search(/\)\s*->\s*str\s*:/);
    const body = (sigEnd >= 0 ? resolver.slice(resolver.indexOf("\n", sigEnd)) : resolver)
      .replace(/"""[\s\S]*?"""/g, "")
      .replace(/'''[\s\S]*?'''/g, "");
    if (body.trim().length < 40) {
      fail(`${CLIENT}: build_opening_message has an empty/stub body — a resolver that returns a constant makes greeting_style and custom_greeting decorative again`);
    }

    // It must read BOTH knobs...
    if (!/\bgreeting_style\b/.test(body)) {
      fail(`${CLIENT}: build_opening_message never reads greeting_style`);
    }
    if (!/\bcustom_greeting\b/.test(body)) {
      fail(`${CLIENT}: build_opening_message never reads custom_greeting`);
    }
    // ...and the custom branch must actually be able to win. A resolver that
    // reads custom_greeting only to log it, or that checks it after an
    // unconditional return, leaves the field decorative while every
    // "is it mentioned" assertion above still passes.
    if (!/greeting_style == "custom"/.test(body)) {
      fail(`${CLIENT}: build_opening_message must branch on greeting_style == "custom" — otherwise selecting "custom" in the dashboard changes nothing`);
    }
    if (!/return custom_greeting/.test(body)) {
      fail(`${CLIENT}: the custom branch of build_opening_message must return custom_greeting (reading it without returning it is the dead-config bug with extra steps)`);
    }
    // The custom branch must come FIRST. This client has a single audio
    // channel, so if intro_prompt is checked first a configured custom
    // greeting is unreachable whenever intro_prompt is non-empty -- and
    // intro_prompt is non-empty by default in config.py.
    const customAt = body.indexOf('greeting_style == "custom"');
    const introAt = body.search(/\bintro_prompt\b/);
    if (customAt >= 0 && introAt >= 0 && introAt < customAt) {
      fail(`${CLIENT}: build_opening_message checks intro_prompt before the custom greeting; intro_prompt has a non-empty default, so the custom branch would be unreachable in a default deployment`);
    }
    // Never return empty: the provider sends the opening as a conversation
    // item unconditionally, so an empty opening makes the agent open silently.
    if (!/return \(/.test(body) && !/return f"/.test(body)) {
      fail(`${CLIENT}: build_opening_message has no synthesised fallback return — with every knob empty it must still produce a greeting, because the provider sends the opening item unconditionally and an empty one opens the call with silence`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. The resolver must be wired into the live answer path, reading BOTH
  //    sources of truth (the active agent_configs row, else env).
  // -------------------------------------------------------------------------
  const answer = pyBlock(code, "def", "_answer_call");
  if (!answer) {
    fail(`${CLIENT}: async def _answer_call not found`);
  } else if (!/opening_message=build_opening_message\(/.test(answer)) {
    fail(`${CLIENT}: _answer_call must build RealtimeSession(opening_message=build_opening_message(...)) — a resolver that is defined but not called changes nothing`);
  } else {
    for (const field of ["greeting_style", "custom_greeting"]) {
      if (!new RegExp(`active_config\\.${field}`).test(answer)) {
        fail(`${CLIENT}: _answer_call must pass active_config.${field} when an agent config row is active (otherwise the admin API field is decorative)`);
      }
      if (!new RegExp(`self\\.settings\\.${field}`).test(answer)) {
        fail(`${CLIENT}: _answer_call must fall back to self.settings.${field} when no agent config row is active`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. The opening must not be reassigned to a raw field after the resolver
  //    runs. "Fixing" a greeting complaint by appending
  //    `session.opening_message = intro_prompt` restores the original bug with
  //    the resolver still in the tree and every assertion above green.
  // -------------------------------------------------------------------------
  if (/\.opening_message\s*=\s*(?!build_opening_message)/.test(code.replace(/opening_message=build_opening_message\(/g, ""))) {
    fail(`${CLIENT}: opening_message is reassigned outside build_opening_message — the resolved greeting is being overwritten by a raw field`);
  }
}

if (failures.length) {
  console.error("greeting-config guard FAILED:\n");
  for (const f of failures) console.error("  * " + f);
  console.error(
    "\ngreeting_style and custom_greeting are configurable via env, the agent_configs\n" +
      "row, the admin API and the voice-web dashboard. If the Telegram client does not\n" +
      "resolve the opening message from them, every one of those surfaces reports a\n" +
      "greeting the caller never hears. See BAS-234 / scripts/GREETING-CONFIG-AUDIT.md.",
  );
  process.exit(1);
}

console.log("greeting-config guard OK: greeting_style/custom_greeting are resolved from config+DB and drive the realtime opening message.");
