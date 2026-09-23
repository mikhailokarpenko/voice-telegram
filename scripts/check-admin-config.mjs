#!/usr/bin/env node
// Guard: voice-phone / voice-telegram admin credentials must never come from a
// generated or silently-empty default.
//
// Why:
//   * `admin_jwt_secret: str = secrets.token_urlsafe(32)` was evaluated once per
//     process. Every restart invalidated all outstanding admin sessions, and two
//     replicas could not validate each other's tokens, so admin auth failed
//     non-deterministically behind a load balancer (voice-web logs in to each
//     upstream per request, surfacing as intermittent 502 "authentication
//     failed").
//   * A generated-by-default secret also makes it easy to deploy believing a
//     secret was configured when none was.
//   * `admin_password` defaulted to SecretStr(""). verify_password fails closed,
//     but the service started happily in a state where admin could never log in.
//
// Fix asserted here: both settings default to empty AND a model validator makes
// them required (with a minimum secret length) when environment == production,
// so misconfiguration fails fast at startup instead of at 3am.
//
// Run: node voice-telegram/scripts/check-admin-config.mjs   (exit 0 = safe)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
// Layout A (monorepo/voice-suite checkout): <voiceRoot>/voice-telegram/scripts/...
// Layout B (voice-telegram checked out alone, e.g. GitHub Actions): repo root IS
// voice-telegram. The sibling voice-phone repo is then absent and is skipped.
const parent = resolve(here, '..', '..');
const standalone = !existsSync(resolve(parent, 'voice-telegram/src/voice_telegram/config.py'));
const voiceRoot = standalone ? resolve(repoRoot, '..') : parent;
const telegramConfig = standalone
  ? resolve(repoRoot, 'src/voice_telegram/config.py')
  : resolve(parent, 'voice-telegram/src/voice_telegram/config.py');
const telegramEnv = standalone
  ? resolve(repoRoot, '.env.example')
  : resolve(parent, 'voice-telegram/.env.example');

// This copy lives in voice-telegram, so voice-telegram is the repo it must
// always cover; voice-phone is the optional sibling.
const OWN = 'voice-telegram';

const targets = [
  {
    name: 'voice-telegram',
    config: telegramConfig,
    env: telegramEnv,
  },
  {
    name: 'voice-phone',
    config: resolve(voiceRoot, 'voice-phone/src/voice_agent/config.py'),
    env: resolve(voiceRoot, 'voice-phone/.env.example'),
  },
];

const failures = [];

const skipped = [];

for (const target of targets) {
  // voice-phone and voice-telegram live in separate git repos; when the guard
  // runs from a checkout that only contains one of them, skip the absent
  // sibling instead of crashing (CI for voice-phone alone must still pass).
  if (!existsSync(target.config)) {
    if (target.name === OWN) {
      failures.push(`${OWN}: config.py not found (guard must always cover its own repo)`);
    } else {
      skipped.push(target.name);
    }
    continue;
  }
  const src = readFileSync(target.config, 'utf8');
  const fail = (msg) => failures.push(`${target.name}: ${msg}`);

  const jwtLine = src.match(/^\s*admin_jwt_secret\s*:.*$/m)?.[0];
  const pwdLine = src.match(/^\s*admin_password\s*:.*$/m)?.[0];

  if (!jwtLine) fail('admin_jwt_secret setting not found');
  if (!pwdLine) fail('admin_password setting not found');

  if (jwtLine && /secrets\.|token_urlsafe|token_hex|uuid|random/.test(jwtLine)) {
    fail(`admin_jwt_secret must not have a generated default: ${jwtLine.trim()}`);
  }
  if (jwtLine && !/=\s*""\s*$/.test(jwtLine)) {
    fail(`admin_jwt_secret must default to "" (explicit config required): ${jwtLine.trim()}`);
  }
  if (pwdLine && !/=\s*SecretStr\(""\)\s*$/.test(pwdLine)) {
    fail(`admin_password must default to SecretStr(""): ${pwdLine.trim()}`);
  }
  if (/^import secrets$/m.test(src)) {
    fail('config.py still imports `secrets` (no generated defaults should remain)');
  }

  // Fail-fast validator.
  if (!/@model_validator\(mode="after"\)/.test(src)) {
    fail('config.py must have a model_validator enforcing admin credentials');
  }
  if (!/require_admin_credentials/.test(src)) {
    fail('missing require_admin_credentials validator');
  }

  // The decorator must be attached to the validator itself. A renamed or
  // detached validator (e.g. `def _disabled_require_admin_credentials`, or a
  // @model_validator left on some unrelated method) leaves production booting
  // with no admin credentials while the two independent substring checks above
  // still pass -- that mutant escaped this guard until it was mutation-tested.
  if (!/@model_validator\(mode="after"\)\s*\n\s*def require_admin_credentials\s*\(/.test(src)) {
    fail('@model_validator(mode="after") must decorate def require_admin_credentials directly');
  }
  // ...and it must actually raise, not just compute a list of missing vars.
  const body = src.split(/def require_admin_credentials\s*\(/)[1] ?? '';
  if (!/raise\s+ValueError/.test(body.split(/\n    @|\n    def /)[0] ?? '')) {
    fail('require_admin_credentials must raise ValueError when required admin settings are missing');
  }
  for (const needle of ['ADMIN_PASSWORD', 'ADMIN_JWT_SECRET', 'MIN_ADMIN_JWT_SECRET_LENGTH']) {
    if (!src.includes(needle)) fail(`validator does not reference ${needle}`);
  }
  if (!/environment\s*!=\s*"production"/.test(src)) {
    fail('validator must gate the hard requirement on environment == production');
  }

  if (!existsSync(target.env)) {
    fail('.env.example not found');
    continue;
  }
  const env = readFileSync(target.env, 'utf8');
  for (const key of ['ADMIN_PASSWORD', 'ADMIN_JWT_SECRET']) {
    if (!new RegExp(`^${key}=`, 'm').test(env)) {
      fail(`.env.example is missing ${key}`);
    }
  }
  if (!/Required in production/.test(env)) {
    fail('.env.example must document that the admin settings are required in production');
  }
}

if (failures.length > 0) {
  console.error('check-admin-config: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

for (const name of skipped) {
  console.log(`check-admin-config: skipped ${name} (not present in this checkout)`);
}
console.log('check-admin-config: OK (no generated admin secrets; production fails fast if unset)');
