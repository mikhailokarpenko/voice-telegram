"""Security response headers for the voice services.

Defence-in-depth behind the BAS-213 stored-XSS fix. The dashboards render
attacker-influenced call fields (Twilio ``From``/``To``/``CallSid``, provider
``error`` strings); those are now escaped, but a future regression should not
be a full admin takeover. These headers cap the blast radius:

* ``Content-Security-Policy`` -- ``connect-src``/``img-src``/``media-src`` are
  pinned to ``'self'``, so an injected payload cannot beacon transcripts or
  recordings to an attacker host; ``object-src``/``base-uri`` ``'none'`` kill
  plugin and ``<base>`` hijack tricks; ``frame-ancestors 'none'`` and
  ``X-Frame-Options: DENY`` block clickjacking of the admin controls;
  ``form-action 'self'`` stops credential-posting forms.
* This service no longer serves a dashboard HTML page (the unified dashboard
  lives in voice-web, which since BAS-217 loads its script from a same-origin
  ``/static/app.js``), so ``script-src`` is ``'self'`` with no
  ``'unsafe-inline'``. ``style-src`` keeps ``'unsafe-inline'`` for the Pico CSS
  component styles; that is not a script-execution channel.
* Stylesheets come from the pinned jsDelivr Pico CSS, allow-listed in
  ``style-src``/``font-src`` only -- not in ``script-src``.

``Strict-Transport-Security`` is only emitted when the service is deployed on
HTTPS, so local HTTP development is unaffected.
"""

from collections.abc import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

CDN = "https://cdn.jsdelivr.net"

CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self'",
        f"style-src 'self' 'unsafe-inline' {CDN}",
        f"font-src 'self' data: {CDN}",
        "img-src 'self' data:",
        "media-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ]
)

STATIC_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
}

HSTS = "max-age=31536000; includeSubDomains"


def apply_security_headers(response: Response, *, https: bool) -> Response:
    for name, value in STATIC_HEADERS.items():
        response.headers[name] = value
    if https:
        response.headers["Strict-Transport-Security"] = HSTS
    return response


def install_security_headers(app: ASGIApp, *, public_base_url: str) -> None:
    """Attach the security-header middleware to a FastAPI/Starlette app."""

    https = public_base_url.strip().lower().startswith("https")

    @app.middleware("http")
    async def _security_headers(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        return apply_security_headers(response, https=https)
