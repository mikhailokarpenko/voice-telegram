# admin-XSS "API-only" ratchet — mutation audit (voice-phone + voice-telegram)

Gilfoyle, heartbeat run `10c908a8`.

## The problem

`voice-phone/scripts/check-admin-xss.mjs` has two branches: escaping assertions for a
voice-phone dashboard, and escaping assertions for the voice-web one. In voice-phone's own CI
**both are skipped** — the service is API-only and voice-web is not checked out. All that
remains is a "still API-only?" sweep, and that sweep is the guard's entire value in this repo.

Its mutation harness had **5 mutants**, the weakest in the suite (voice-web's has 26).

`voice-telegram` had **no admin-XSS guard at all**, despite being in the identical position:
it stores attacker-influenced call data (Telegram peer identity, call ids, provider error
strings) and serves it from `/api/admin/calls`. JSON-only today, so no sink — but that is a
property of today's tree, not an invariant. voice-phone was in exactly this position and the
dashboard came back in voice-web with a quote-unsafe escaper
(`div.textContent = v; return div.innerHTML` does not encode `"`).

## Four verified escapes of the old sweep

The old sweep walked `src/` only, matched `.html` only, and looked for `HTMLResponse(` /
`text/html` only. Each of the following was confirmed **green** against it before the fix —
every one re-adds a real admin dashboard fed by stored call data, with zero escaping
assertions anywhere in CI:

| evasion | why it was invisible |
|---|---|
| `Jinja2Templates(...).TemplateResponse("calls.html.j2", ...)` | never writes `HTMLResponse` or `text/html`; `.html.j2` was not a recognised extension |
| `StaticFiles(directory="static", html=True)` | markup sits at the repo root, **outside `src/`**; the mounting `.py` contains neither trigger string |
| `index.htm` | one character short of the only extension checked |
| `FileResponse("assets/index.html")` | same — no trigger string |

## Fix

New `scripts/lib-markup-sweep.mjs` (shared, identical in both repos): walks the **whole repo**
minus an explicit deny-list, knows template extensions (`.j2/.jinja/.jinja2/.htm/.xhtml/...`)
and six Python HTML-serving signals (`HTMLResponse`, `text/html`, `TemplateResponse`,
`Jinja2Templates`, `StaticFiles(html=True)`, `FileResponse(....html)`).

That moves the blind spot into the deny-list, so the deny-list is itself asserted — and the
first attempt at that was not enough. **Two further escapes, found by mutating the new code:**

1. **The library was trusted.** Every assertion in the guard is negative ("found nothing"), so
   `sweepForMarkup()` stubbed to `return []`, an emptied `PY_HTML_SIGNALS`, or a `MARKUP_EXT`
   narrowed back to `[".html"]` all reported API-only forever while a dashboard shipped.
   *Fix:* the guard plants six known dashboards (plain markup, `.htm`, a Jinja template, a
   `TemplateResponse` renderer, an `html=True` mount, markup outside `src/`) in a throwaway
   temp tree and requires the sweep to find each — plus an ordinary JSON handler it must
   **not** flag, so a yes-to-everything stub fails too.
2. **`assertExclusions()` was trusted.** Widening `EXCLUDED_DIRS` *and* stubbing
   `assertExclusions()` to `return null` passed. *Fix:* the skip set is measured
   **behaviourally** — plant a dashboard in a directory named for each candidate, record which
   ones the sweep really ignores, and require the observed set to equal the pinned one. The
   candidate list is collected recursively, because the first version enumerated only
   top-level directories and a nested `src/voice_agent/ui` slipped straight through it.

## voice-telegram

New `scripts/check-admin-xss.mjs`: the same ratchet, written as a first-class guard rather
than a skip path. On failure it names the file and tells the reader to port voice-web's
escaping assertions before merging. Wired into `ci.yml`.

Its vacuity backstop needed a second assertion: the sweep self-test alone contributes seven
assertions, so deleting the actual API-only claim left the guard well over any count threshold
and still green. The claim is now identified **by name**, not counted.

Of note: `check-ci-wiring.mjs` flagged both new files as unwired before I added the CI step —
the wiring ratchet from run `50e4d5df` worked unprompted. `lib-markup-sweep.mjs` was added to
`NOT_AN_ENTRYPOINT` in all three repos (libraries are imported, not executed).

## Mutation matrix

**voice-phone: 14 mutants, 14 caught, 0 escaped, 0 no-op** (was 5 mutants, and 4 of the new
ones escaped the pre-fix guard).
**voice-telegram: 14 mutants, 14 caught, 0 escaped, 0 no-op** (was no guard).

| mutant | phone | telegram |
|---|---|---|
| dashboard `.html` re-added under `src/` | caught | caught |
| dashboard in a nested directory | caught | caught |
| inline `HTMLResponse` in a `.py` | caught | caught |
| route serves `text/html` | caught | caught |
| the API-only claim deleted | caught | caught (**needed the by-name assertion**) |
| Jinja2 `TemplateResponse` dashboard | caught (**was ESCAPING**) | caught |
| `StaticFiles(html=True)`, markup outside `src/` | caught (**was ESCAPING**) | caught |
| `index.htm` | caught (**was ESCAPING**) | caught |
| `FileResponse('.../index.html')` | caught (**was ESCAPING**) | caught |
| `EXCLUDED_DIRS` widened to hide the new dir | caught | caught |
| `MARKUP_EXT` narrowed to `.html` | caught (**escaped fix v1**) | caught |
| `PY_HTML_SIGNALS` emptied | caught (**escaped fix v1**) | caught |
| `sweepForMarkup()` → `return []` | caught (**escaped fix v1**) | caught |
| `assertExclusions()` → `return null` + widened list | caught (**escaped fix v2**) | caught |

Each harness asserts the guard is green on the clean sandbox **first** (else every mutant is
trivially "caught" and the audit is vacuous), reports `MUTATOR-ERROR` when a mutator regex
matches nothing rather than counting it as a catch, mutates only a disposable temp tree, and
byte-compares both `check-admin-xss.mjs` and `lib-markup-sweep.mjs` in the working tree
afterwards.

## Collateral

All `check-*.mjs` and all `test-*.mjs` green at HEAD in all three repos (16 / 12 / 16).
Working trees carry only the intended edits; the harnesses leave no residue, so the `guards`
job's `git diff --exit-code` passes.

## Publication

Commits are **unpushed**: this run has no managed GitHub identity
(`No managed GitHub identity is available for this run`), the same blocker as BAS-228.
