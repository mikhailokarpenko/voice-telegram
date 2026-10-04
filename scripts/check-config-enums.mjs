#!/usr/bin/env node
// Guard: config values the dashboard offers as a closed set must be validated
// as a closed set by the API.
//
// Why this exists (BAS-238):
//   GET /api/admin/voices serves AVAILABLE_VOICES and the dashboard renders its
//   Voice <select> from it; Greeting Style is a fixed five-option <select>.
//   But PUT /api/admin/config validated `openai_voice` and `greeting_style` as
//   `str(max_length=32)` only. Any client that was not that exact dashboard --
//   curl, a script, a stale cached bundle, a tampered DOM -- could persist
//   `openai_voice="nope"`. The API accepted it, wrote it to agent_configs, and
//   echoed it back in the 200 response, so every surface reported a voice that
//   does not exist. Nothing failed until the next inbound call, when the
//   realtime session was opened with an unknown voice and the call dropped.
//
//   Same dead/false-config family as BAS-230 (max_call_seconds enforced
//   nowhere) and BAS-234 (greeting knobs read nowhere). Here the knob IS read
//   by the runtime -- which is precisely why an unvalidated value turns a
//   silent save into a broken call.
//
//   The validators must sit on the WRITE model only. A strict read model would
//   make GET /config raise on a row persisted before this fix, so the operator
//   could never see or correct the bad value through the dashboard. Reject on
//   the way in; surface on the way out.
//
// Static (node-only, no Python/deps) so it runs in the `guards` CI job.
//
// Run: node scripts/check-config-enums.mjs   (exit 0 = safe)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyBlock, stripComments } from "./lib-py-blocks.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Resolved per-repo so the guard is identical in voice-phone and voice-telegram.
const ROUTES = ["src/voice_telegram/admin/routes.py", "src/voice_agent/admin/routes.py"].find(
  (rel) => existsSync(join(repoRoot, rel)),
);

const failures = [];
const fail = (msg) => failures.push(msg);

if (!ROUTES) {
  fail("admin/routes.py not found; guard must run from the repo root");
} else {
  const raw = readFileSync(join(repoRoot, ROUTES), "utf8");
  // Comments and docstrings satisfy every substring check while the code
  // enforces nothing -- the exact hole that let two mutants escape the
  // BAS-234 guard's first draft.
  const code = stripComments(raw)
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/'''[\s\S]*?'''/g, "");

  // -------------------------------------------------------------------------
  // 1. The allowlists must exist, as live code, and be non-trivial.
  //    An empty frozenset would reject everything (and an `in` test against a
  //    plain string would accept any substring), so assert the shape too.
  // -------------------------------------------------------------------------
  const voiceIds = /^VOICE_IDS\s*=\s*frozenset\(/m.exec(code);
  if (!voiceIds) {
    fail(
      `${ROUTES}: VOICE_IDS = frozenset(...) not found — without a derived allowlist the /voices endpoint and the PUT /config validation can drift apart, which is how an unknown voice got persisted`,
    );
  } else if (!/VOICE_IDS\s*=\s*frozenset\(\s*v\["id"\] for v in AVAILABLE_VOICES\s*\)/.test(code)) {
    fail(
      `${ROUTES}: VOICE_IDS must be derived from AVAILABLE_VOICES — a hand-copied second list is a list that will be edited once and not twice, and the dashboard would offer a voice the API rejects`,
    );
  }

  const styles = /^GREETING_STYLES\s*=\s*frozenset\(\{([\s\S]*?)\}\)/m.exec(code);
  if (!styles) {
    fail(`${ROUTES}: GREETING_STYLES = frozenset({...}) not found`);
  } else {
    const members = [...styles[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    // "custom" is load-bearing: the resolver branches on it, so dropping it
    // from the allowlist makes the dashboard's Custom Greeting textarea
    // unreachable via a 422 instead of silently -- still a broken feature.
    for (const required of ["casual", "custom"]) {
      if (!members.includes(required)) {
        fail(
          `${ROUTES}: GREETING_STYLES is missing "${required}" — the dashboard offers it, so the API must accept it`,
        );
      }
    }
    if (members.length < 2) {
      fail(`${ROUTES}: GREETING_STYLES has ${members.length} member(s); an allowlist that small rejects the dashboard's own options`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. The write model must actually validate, with live validators whose
  //    bodies reach the allowlist AND raise.
  // -------------------------------------------------------------------------
  const payload = pyBlock(code, "class", "ConfigPayload");
  if (!payload) {
    fail(`${ROUTES}: class ConfigPayload not found`);
  } else {
    for (const [field, listName] of [
      ["openai_voice", "VOICE_IDS"],
      ["greeting_style", "GREETING_STYLES"],
    ]) {
      if (!new RegExp(`@field_validator\\(\\s*"${field}"`).test(payload)) {
        fail(
          `${ROUTES}: ConfigPayload has no @field_validator("${field}") — max_length alone accepts any string, so the API confirms a value the provider will reject mid-call`,
        );
        continue;
      }
      // Find the validator function that follows the decorator and assert on
      // its body: a validator that reads the allowlist and returns the value
      // anyway passes every "is it mentioned" check.
      const after = payload.slice(payload.search(new RegExp(`@field_validator\\(\\s*"${field}"`)));
      const defName = /def\s+(\w+)\s*\(/.exec(after);
      const body = defName ? pyBlock(after, "def", defName[1]) : null;
      if (!body) {
        fail(`${ROUTES}: the @field_validator("${field}") decorator is not attached to a function`);
        continue;
      }
      if (!new RegExp(`not in\\s+${listName}\\b`).test(body)) {
        fail(
          `${ROUTES}: the ${field} validator has no \`not in ${listName}\` membership test — naming the allowlist in an error message while comparing against something else (or against nothing) leaves every value accepted`,
        );
      }
      if (!/not in /.test(body)) {
        fail(
          `${ROUTES}: the ${field} validator has no membership test — reading the allowlist without comparing against it leaves every value accepted`,
        );
      }
      if (!/raise ValueError/.test(body)) {
        fail(
          `${ROUTES}: the ${field} validator never raises ValueError — pydantic treats a non-raising validator as success, so the bad value is persisted and echoed back as applied`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. The read model must NOT inherit the validators.
  //    ConfigResponse(ConfigPayload) makes GET /config raise on any row
  //    persisted before this fix, locking the operator out of the only screen
  //    where the bad value could be corrected. This is a real regression, not
  //    a style note, so the guard fails on it.
  // -------------------------------------------------------------------------
  const respBase = /^class ConfigResponse\((\w+)\)/m.exec(code);
  if (!respBase) {
    fail(`${ROUTES}: class ConfigResponse not found`);
  } else if (respBase[1] === "ConfigPayload") {
    fail(
      `${ROUTES}: ConfigResponse inherits ConfigPayload, so the write validators run on reads — GET /config would 500 for any agent_configs row holding a pre-existing out-of-allowlist voice, and the dashboard could never display or fix it. Inherit the unvalidated field base instead`,
    );
  } else {
    const base = pyBlock(code, "class", respBase[1]);
    if (!base) {
      fail(`${ROUTES}: ConfigResponse inherits ${respBase[1]}, which is not defined in this module`);
    } else if (/@field_validator/.test(base)) {
      fail(
        `${ROUTES}: ${respBase[1]} (the ConfigResponse base) carries @field_validator — reads are validated again, which 500s GET /config on legacy rows`,
      );
    } else if (!/openai_voice/.test(base) || !/greeting_style/.test(base)) {
      fail(`${ROUTES}: ${respBase[1]} does not declare the config fields; ConfigResponse would not serialise them`);
    }
    // ...and ConfigPayload must still be the validated one, i.e. it must
    // extend that same base rather than quietly become an unused sibling.
    if (!new RegExp(`^class ConfigPayload\\(${respBase[1]}\\)`, "m").test(code)) {
      fail(
        `${ROUTES}: ConfigPayload must extend ${respBase[1]} — if the write model stops sharing the field base the two drift and PUT /config silently validates a different set of fields than it stores`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. PUT /config must still bind ConfigPayload. Switching the body type to
  //    the unvalidated base is a one-word edit that restores the whole bug
  //    with every assertion above green.
  // -------------------------------------------------------------------------
  const update = pyBlock(code, "def", "update_config");
  if (!update) {
    fail(`${ROUTES}: async def update_config not found`);
  } else if (!/body:\s*ConfigPayload/.test(update)) {
    fail(
      `${ROUTES}: update_config must take body: ConfigPayload — binding the unvalidated base means PUT /config accepts any voice again`,
    );
  }
}

if (failures.length) {
  console.error("config-enum guard FAILED:\n");
  for (const f of failures) console.error("  * " + f);
  console.error(
    "\nThe dashboard offers openai_voice and greeting_style as closed sets. If the\n" +
      "API does not validate them as closed sets, an out-of-allowlist value is saved,\n" +
      "echoed back as applied, and only fails later on a live call. See BAS-238 /\n" +
      "scripts/CONFIG-ENUM-AUDIT.md.",
  );
  process.exit(1);
}

console.log("config-enum guard OK: openai_voice/greeting_style are allowlist-validated on write and not on read.");
