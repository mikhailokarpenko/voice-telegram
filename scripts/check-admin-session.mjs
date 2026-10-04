#!/usr/bin/env node
// Guard: the voice-telegram admin SESSION layer must stay intact.
//
// Why this exists, when check-login-throttle / check-admin-config already run:
// those two pin the *front door* (one shared password, throttled, no generated
// default secret). Nothing pinned what happens AFTER login -- the signed
// cookie that every subsequent request is authorised by, and the dependency
// that actually checks it. That layer has at least five total-bypass mutations
// that every existing guard in this repo is green against:
//
//   1. `jwt.decode(..., options={"verify_signature": False})` -- anyone mints
//      an admin token with a text editor; no secret needed.
//   2. `algorithms=["HS256", "none"]` (or algorithms taken from the token) --
//      the classic alg-confusion forgery.
//   3. `except jwt.InvalidTokenError: return {}` -- an invalid/expired token
//      becomes a valid session instead of a 401; fails OPEN.
//   4. `httponly=True` dropped from set_cookie -- any XSS in the dashboard
//      (see check-admin-xss) upgrades from defacement to session theft.
//   5. `Depends(_require_auth)` dropped from one route handler -- that single
//      endpoint (transcripts, config write) becomes unauthenticated, and no
//      guard, lint or type check notices.
//
// Discovery of the routes is from the file, never from a list in this guard,
// so a NEW unauthenticated route is itself a failure. Every assertion runs
// against an extracted block whose existence is asserted first -- a renamed or
// deleted block is a FAILURE, never a vacuous pass (the repeated guard defect
// in this repo's audit history).
//
// Run: node scripts/check-admin-session.mjs   (exit 0 = safe)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pyBlock, stripComments } from "./lib-py-blocks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => stripComments(readFileSync(join(root, p), "utf8"));

const AUTH_PY = "src/voice_telegram/admin/auth.py";
const ROUTES_PY = "src/voice_telegram/admin/routes.py";
const DEP = "_require_auth";
const COOKIE = "admin_token";
// Endpoints that are unauthenticated by design. Anything else must depend on
// the auth dependency. Keep this list minimal and justified:
//   login  - mints the session (throttled; see check-login-throttle)
//   logout - only clears a cookie
const PUBLIC_ROUTES = new Set(["POST /login", "POST /logout"]);

const auth = read(AUTH_PY);
const routes = read(ROUTES_PY);

const failures = [];
const assert = (cond, msg) => { if (!cond) failures.push(msg); };

// ---- token verification --------------------------------------------------
const decode = pyBlock(auth, "def", "decode_token");
assert(decode, `${AUTH_PY}: decode_token() is gone (renamed or deleted) -- nothing verifies the session token`);
if (decode) {
  assert(decode.length > 150, `${AUTH_PY}: decode_token() body is suspiciously small -- gutted?`);
  assert(/jwt\.decode\(/.test(decode),
    `${AUTH_PY}: decode_token() no longer calls jwt.decode() -- the signature is not verified`);

  // Signature verification must not be switched off.
  assert(!/verify_signature["']?\s*:\s*False/.test(decode) && !/verify_exp["']?\s*:\s*False/.test(decode),
    `${AUTH_PY}: decode_token() disables signature/expiry verification via options= -- any forged token is accepted`);

  // The algorithm list must be a literal allow-list of exactly HS256. A list
  // built from the token header, or one containing "none", is a forgery.
  const algs = /algorithms\s*=\s*\[([^\]]*)\]/.exec(decode);
  assert(algs, `${AUTH_PY}: decode_token() no longer passes a literal algorithms=[...] allow-list to jwt.decode()`);
  if (algs) {
    const list = algs[1].split(",").map((s) => s.trim().replace(/^_?[A-Z_]+$/, (m) => m)).filter(Boolean);
    assert(list.length === 1,
      `${AUTH_PY}: decode_token() accepts ${list.length} JWT algorithms; exactly one (HS256) must be allowed`);
    assert(!/none/i.test(algs[1]),
      `${AUTH_PY}: decode_token() allows the "none" algorithm -- unsigned tokens would be accepted`);
    assert(/HS256|_ALGORITHM/.test(algs[1]),
      `${AUTH_PY}: decode_token() no longer pins HS256`);
  }
  assert(!/algorithms\s*=\s*(?!\[)/.test(decode) || /algorithms\s*=\s*\[/.test(decode),
    `${AUTH_PY}: decode_token() computes its algorithm list dynamically -- it must be a literal`);
  if (/_ALGORITHM/.test(decode)) {
    assert(/^_ALGORITHM\s*=\s*"HS256"\s*$/m.test(auth),
      `${AUTH_PY}: _ALGORITHM is no longer the literal "HS256"`);
  }

  // Failure must raise 401. `return {}` / `return None` / `pass` makes an
  // invalid token a valid session: fail-open.
  const handlers = decode.split(/\n\s*except\b/).slice(1);
  assert(handlers.length >= 1, `${AUTH_PY}: decode_token() no longer handles JWT errors`);
  for (const h of handlers) {
    assert(/\braise\s+HTTPException\(/.test(h),
      `${AUTH_PY}: a decode_token() except-handler does not raise HTTPException -- an invalid token fails OPEN`);
    assert(/HTTP_401_UNAUTHORIZED/.test(h),
      `${AUTH_PY}: a decode_token() except-handler no longer returns 401`);
    assert(!/^\s*(return|pass)\b/m.test(h.split("raise")[0]),
      `${AUTH_PY}: a decode_token() except-handler returns before raising -- invalid tokens are accepted`);
  }
  assert(!/\btry\s*:\s*\n\s*pass/.test(decode),
    `${AUTH_PY}: decode_token()'s verification body was replaced by pass`);
}

// ---- token minting -------------------------------------------------------
const create = pyBlock(auth, "def", "create_token");
assert(create, `${AUTH_PY}: create_token() is gone`);
if (create) {
  assert(/jwt\.encode\(/.test(create), `${AUTH_PY}: create_token() no longer signs the token`);
  assert(/\bexp\b/.test(create),
    `${AUTH_PY}: create_token() no longer sets an "exp" claim -- admin sessions never expire`);
  assert(/timedelta\(hours=_TOKEN_EXPIRY_HOURS\)|timedelta\(/.test(create),
    `${AUTH_PY}: create_token()'s expiry is no longer a timedelta`);
  const hours = /^_TOKEN_EXPIRY_HOURS\s*=\s*([0-9_]+)\s*$/m.exec(auth);
  assert(hours, `${AUTH_PY}: _TOKEN_EXPIRY_HOURS is gone`);
  if (hours) {
    assert(Number(hours[1].replace(/_/g, "")) <= 24,
      `${AUTH_PY}: the admin session lifetime was widened to ${hours[1]}h; 24h is the cap`);
  }
  assert(/admin_jwt_secret/.test(create),
    `${AUTH_PY}: create_token() no longer signs with settings.admin_jwt_secret`);
}

// ---- password comparison -------------------------------------------------
const verify = pyBlock(auth, "def", "verify_password");
assert(verify, `${AUTH_PY}: verify_password() is gone`);
if (verify) {
  assert(/hmac\.compare_digest\(/.test(verify),
    `${AUTH_PY}: verify_password() no longer uses hmac.compare_digest -- the comparison is timing-variable`);
  assert(/\bbool\(stored\)|if not stored/.test(verify),
    `${AUTH_PY}: verify_password() no longer rejects an EMPTY configured password -- "" would authenticate`);
  assert(!/\breturn\s+True\b/.test(verify),
    `${AUTH_PY}: verify_password() contains an unconditional return True`);
}

// ---- the session cookie --------------------------------------------------
const login = pyBlock(routes, "def", "login");
assert(login, `${ROUTES_PY}: the login handler is gone`);
if (login) {
  const sc = login.indexOf("set_cookie");
  assert(sc >= 0, `${ROUTES_PY}: login() no longer sets the session cookie`);
  if (sc >= 0) {
    const call = login.slice(sc, login.indexOf(")", login.indexOf("path=", sc)) + 1);
    assert(/httponly\s*=\s*True/.test(call),
      `${ROUTES_PY}: the ${COOKIE} cookie is no longer HttpOnly -- XSS in the dashboard would steal the admin session`);
    assert(/samesite\s*=\s*"strict"/.test(call),
      `${ROUTES_PY}: the ${COOKIE} cookie is no longer SameSite=strict -- cross-site requests would carry the admin session (CSRF)`);
    assert(/secure\s*=\s*settings\.public_base_url\.startswith\("https"\)/.test(call),
      `${ROUTES_PY}: the ${COOKIE} cookie's Secure flag is no longer derived from the https deployment URL`);
    assert(/create_token\(/.test(call),
      `${ROUTES_PY}: the ${COOKIE} cookie value is no longer a freshly signed token`);
    assert(/max_age\s*=/.test(call),
      `${ROUTES_PY}: the ${COOKIE} cookie no longer has a max_age -- it would persist as a session cookie only, or forever`);
  }
}

// ---- the auth dependency -------------------------------------------------
const dep = pyBlock(routes, "def", DEP);
assert(dep, `${ROUTES_PY}: the ${DEP} dependency is gone (renamed or deleted)`);
if (dep) {
  assert(/if not admin_token:/.test(dep) || /if\s+admin_token\s+is\s+None/.test(dep),
    `${ROUTES_PY}: ${DEP}() no longer rejects a missing cookie`);
  assert(/\braise HTTPException\(/.test(dep) && /HTTP_401_UNAUTHORIZED/.test(dep),
    `${ROUTES_PY}: ${DEP}() no longer 401s when the cookie is absent`);
  assert(/\breturn decode_token\(|=\s*decode_token\(/.test(dep),
    `${ROUTES_PY}: ${DEP}() no longer verifies the token via decode_token() -- presence of any cookie would authenticate`);
  assert(!/\breturn\s*\{\s*\}/.test(dep),
    `${ROUTES_PY}: ${DEP}() returns an empty claim dict without verifying`);
}

// ---- every route is authorised -------------------------------------------
// Discovered from the file: a newly added route that forgets the dependency is
// a failure here, which is the whole point.
const lines = routes.split("\n");
const found = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^@router\.(get|post|put|patch|delete|api_route)\(\s*"([^"]*)"/.exec(lines[i]);
  if (!m) continue;
  let method = m[1].toUpperCase();
  // find the handler def that follows the (possibly multi-line) decorator stack
  let j = i;
  while (j < lines.length && !/^\s*(async\s+)?def\s+/.test(lines[j])) j++;
  const name = /def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[j] || "");
  if (!name) continue;
  const block = pyBlock(routes.split("\n").slice(j).join("\n"), "def", name[1]);
  found.push({ key: `${method} ${m[2]}`, name: name[1], block });
}
assert(found.length >= 5,
  `${ROUTES_PY}: only ${found.length} routes were discovered; the decorator scan is broken or the router was gutted (a vacuous pass here would bless every route)`);
for (const r of found) {
  if (PUBLIC_ROUTES.has(r.key)) continue;
  assert(r.block, `${ROUTES_PY}: could not read the body of handler ${r.name} -- refusing to bless it`);
  assert(r.block && new RegExp(`Depends\\(\\s*${DEP}\\s*\\)`).test(r.block),
    `${ROUTES_PY}: route ${r.key} (${r.name}) does not depend on ${DEP} -- it is UNAUTHENTICATED`);
}
// The public list must not have grown.
const publicFound = found.filter((r) => PUBLIC_ROUTES.has(r.key)).length;
assert(publicFound === PUBLIC_ROUTES.size,
  `${ROUTES_PY}: expected exactly ${PUBLIC_ROUTES.size} intentionally-public routes, found ${publicFound} -- the allow-list and the router have diverged`);

if (failures.length) {
  console.error("check-admin-session: FAIL");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`check-admin-session: OK (${found.length} admin routes, ${found.length - publicFound} authorised via ${DEP}; token signature/alg/expiry pinned; cookie HttpOnly+SameSite=strict+Secure)`);
