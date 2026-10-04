#!/usr/bin/env node
// Mutation audit for scripts/check-admin-session.mjs (voice-telegram).
//
// A guard that has never been shown RED proves nothing. Each mutant below
// removes exactly ONE real control from the admin session layer and leaves the
// rest of the tree intact; the guard must fail. A mutant whose regex matches
// nothing is reported NO-OP and never counted as caught -- a stale mutant
// silently inflating the score is the same trap as a vacuous assertion.
//
// Run: node scripts/test-admin-session-guard-mutants.mjs   (exit 0 = 100%)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts", "check-admin-session.mjs");

const FILES = {
  auth: join(root, "src/voice_telegram/admin/auth.py"),
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

const DEP = "_require_auth";

const mutants = [
  // ---- token verification switched off ----------------------------------
  ["jwt.decode with verify_signature disabled (anyone forges an admin token)", "auth", s =>
    s.replace(/algorithms=\[_ALGORITHM\]/, 'algorithms=[_ALGORITHM], options={"verify_signature": False}')],
  ["expiry verification disabled (a 2024 token still works)", "auth", s =>
    s.replace(/algorithms=\[_ALGORITHM\]/, 'algorithms=[_ALGORITHM], options={"verify_exp": False}')],
  ['alg-confusion: algorithms=["HS256", "none"]', "auth", s =>
    s.replace(/algorithms=\[_ALGORITHM\]/, 'algorithms=[_ALGORITHM, "none"]')],
  ["_ALGORITHM relaxed to none", "auth", s =>
    s.replace(/^_ALGORITHM = "HS256"$/m, '_ALGORITHM = "none"')],
  ["algorithms list taken from the attacker-controlled token header", "auth", s =>
    s.replace(/algorithms=\[_ALGORITHM\]/, "algorithms=jwt.get_unverified_header(token)[\"alg\"].split(\",\")")],
  ["jwt.decode() replaced by an unverified claim read", "auth", s =>
    s.replace(/jwt\.decode\(token, settings\.admin_jwt_secret, algorithms=\[_ALGORITHM\]\)/,
      "jwt.decode(token, options={\"verify_signature\": False})")],

  // ---- verification fails OPEN ------------------------------------------
  ["invalid token returns an empty claim dict instead of 401", "auth", s =>
    s.replace(/    except jwt\.InvalidTokenError:\n        raise HTTPException\(status\.HTTP_401_UNAUTHORIZED, "Invalid token"\) from None/,
      "    except jwt.InvalidTokenError:\n        return {}")],
  ["expired token downgraded to a 200 session", "auth", s =>
    s.replace(/    except jwt\.ExpiredSignatureError:\n        raise HTTPException\(status\.HTTP_401_UNAUTHORIZED, "Token expired"\) from None/,
      '    except jwt.ExpiredSignatureError:\n        return {"sub": "admin"}')],
  ["401 on an invalid token downgraded to 403-less pass-through (raise removed)", "auth", s =>
    s.replace(/raise HTTPException\(status\.HTTP_401_UNAUTHORIZED, "Invalid token"\) from None/,
      'return {"sub": "admin"}')],
  ["decode_token() gutted to return unverified claims", "auth", s =>
    s.replace(/def decode_token\(token: str, settings: Settings\) -> dict\[str, Any\]:\n(?:.*\n)*?\n\nclass /,
      'def decode_token(token: str, settings: Settings) -> dict[str, Any]:\n    return {"sub": "admin"}\n\n\nclass ')],
  ["decode_token() renamed (call sites would be rewired by the attacker)", "auth", s =>
    s.replace(/\bdef decode_token\(/, "def _decode_token_unused(")],

  // ---- minting ----------------------------------------------------------
  ["tokens minted without an exp claim (admin sessions never expire)", "auth", s =>
    s.replace(/\s*"exp": now \+ timedelta\(hours=_TOKEN_EXPIRY_HOURS\),/, "")],
  ["session lifetime widened to a year", "auth", s =>
    s.replace(/^_TOKEN_EXPIRY_HOURS = 24$/m, "_TOKEN_EXPIRY_HOURS = 8760")],
  ["create_token() stops signing (jwt.encode removed)", "auth", s =>
    s.replace(/return jwt\.encode\(payload, settings\.admin_jwt_secret, algorithm=_ALGORITHM\)/,
      "return json.dumps(payload, default=str)")],

  // ---- password comparison ----------------------------------------------
  ["verify_password() uses == (timing oracle)", "auth", s =>
    s.replace(/hmac\.compare_digest\(plain\.encode\(\), stored\.encode\(\)\)/, "plain == stored")],
  ["verify_password() accepts an empty configured password", "auth", s =>
    s.replace(/return bool\(stored\) and hmac\.compare_digest/, "return hmac.compare_digest")],
  ["verify_password() always True", "auth", s =>
    s.replace(/return bool\(stored\) and hmac\.compare_digest\([^\n]*\)/, "return True")],

  // ---- the session cookie ------------------------------------------------
  ["session cookie loses HttpOnly (XSS -> session theft)", "routes", s =>
    s.replace(/\n\s*httponly=True,/, "")],
  ["session cookie loses SameSite=strict (CSRF)", "routes", s =>
    s.replace(/\n\s*samesite="strict",/, "")],
  ["session cookie SameSite relaxed to none", "routes", s =>
    s.replace(/samesite="strict"/, 'samesite="none"')],
  ["Secure flag hardcoded off (cookie sent in cleartext)", "routes", s =>
    s.replace(/secure=settings\.public_base_url\.startswith\("https"\)/, "secure=False")],
  ["session cookie loses max_age", "routes", s =>
    s.replace(/\n\s*max_age=86400,/, "")],
  ["login sets a constant cookie value instead of a signed token", "routes", s =>
    s.replace(/create_token\(settings\),/, '"admin",')],

  // ---- the auth dependency ----------------------------------------------
  [`${DEP}() stops verifying the token (any cookie authenticates)`, "routes", s =>
    s.replace(/    return decode_token\(admin_token, _get_settings\(request\)\)/,
      '    return {"sub": "admin"}')],
  [`${DEP}() accepts a missing cookie`, "routes", s =>
    s.replace(/    if not admin_token:\n        raise HTTPException\(status\.HTTP_401_UNAUTHORIZED, "Not authenticated"\)\n/, "")],
  [`${DEP}() 401 downgraded to a silent pass`, "routes", s =>
    s.replace(/        raise HTTPException\(status\.HTTP_401_UNAUTHORIZED, "Not authenticated"\)/,
      '        return {}')],
  [`${DEP}() renamed to something no route depends on`, "routes", s =>
    s.replace(/async def _require_auth\(/, "async def _require_auth_disabled(")],

  // ---- per-route authorisation -------------------------------------------
  ["config READ route loses its auth dependency (transcript/config disclosure)", "routes", s =>
    s.replace(/async def get_config\(\n    request: Request,\n    session: AsyncSession = Depends\(get_db_session\),\n    _claims: dict\[str, Any\] = Depends\(_require_auth\),\n\)/,
      "async def get_config(\n    request: Request,\n    session: AsyncSession = Depends(get_db_session),\n)")],
  ["config WRITE route loses its auth dependency (anyone rewrites the agent prompt)", "routes", s =>
    s.replace(/async def update_config\(\n    body: ConfigPayload,\n    session: AsyncSession = Depends\(get_db_session\),\n    _claims: dict\[str, Any\] = Depends\(_require_auth\),\n\)/,
      "async def update_config(\n    body: ConfigPayload,\n    session: AsyncSession = Depends(get_db_session),\n)")],
  ["call-transcript route loses its auth dependency", "routes", s =>
    s.replace(/async def get_call\(\n    call_id: uuid\.UUID,\n    session: AsyncSession = Depends\(get_db_session\),\n    _claims: dict\[str, Any\] = Depends\(_require_auth\),\n\)/,
      "async def get_call(\n    call_id: uuid.UUID,\n    session: AsyncSession = Depends(get_db_session),\n)")],
  ["a NEW unauthenticated route is added (the discovery case)", "routes", s =>
    s + '\n\n@router.get("/debug/dump")\nasync def debug_dump() -> dict[str, str]:\n    return {"secret": "everything"}\n'],
];

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]),
);
const restore = () => {
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, originals[k]);
};

if (!runGuard()) {
  console.error("BASELINE FAILED: check-admin-session.mjs is already red on the unmutated tree.");
  console.error("Every 'caught' below would be meaningless. Fix the tree or the guard first.");
  process.exit(1);
}

let caught = 0;
const escaped = [];
const noop = [];

for (const [name, key, mutate] of mutants) {
  const before = originals[key];
  const after = mutate(before);
  if (after === before) {
    noop.push(name);
    console.log(`NO-OP   ${name}  (mutator matched nothing -- NOT counted)`);
    continue;
  }
  writeFileSync(FILES[key], after);
  const green = runGuard();
  restore();
  if (green) {
    escaped.push(name);
    console.log(`ESCAPED ${name}`);
  } else {
    caught++;
    console.log(`caught  ${name}`);
  }
}

restore();
if (!runGuard()) {
  console.error("\nPOST-RESTORE FAILED: the tree was not restored cleanly.");
  process.exit(1);
}

console.log(`\n${mutants.length} mutants: ${caught} caught, ${escaped.length} escaped, ${noop.length} no-op`);
if (escaped.length || noop.length) {
  for (const e of escaped) console.error("  ESCAPED: " + e);
  for (const n of noop) console.error("  NO-OP:   " + n);
  process.exit(1);
}
console.log("check-admin-session.mjs catches every mutant.");
