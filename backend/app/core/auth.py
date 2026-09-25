"""Cognito access-token verification and subject-bound API authorization.

The application deliberately keeps its identity boundary here rather than
letting individual route handlers interpret JWT claims.  Development can opt
out with ``AUTH_DISABLED=true``; production fails closed if that flag remains
enabled or Cognito is not configured.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import re
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from fastapi import Header, HTTPException, status

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

_DEV_SUBJECT_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,36}$")
_BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_SHA256_DIGEST_INFO_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


class AuthenticationConfigurationError(RuntimeError):
    """The deployment has not configured a safe identity boundary."""


class IdentityProviderUnavailableError(RuntimeError):
    """Cognito's public key set could not be loaded when verification required it."""


class TokenValidationError(ValueError):
    """A bearer token is malformed, expired, or not valid for this API."""


@dataclass(frozen=True, slots=True)
class Principal:
    """A verified identity used to scope all athlete-owned resources."""

    subject: str
    email: str | None = None
    token_use: str = "access"


def _decode_base64url(value: str) -> bytes:
    if not _BASE64URL_PATTERN.fullmatch(value):
        raise TokenValidationError("invalid base64url JWT field")
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error) as error:
        raise TokenValidationError("invalid base64url JWT field") from error


def _decode_json_segment(value: str) -> dict[str, Any]:
    try:
        decoded = json.loads(_decode_base64url(value))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TokenValidationError("invalid JWT JSON field") from error
    if not isinstance(decoded, dict):
        raise TokenValidationError("JWT JSON field must be an object")
    return decoded


def _verify_rs256_signature(signing_input: bytes, signature: bytes, jwk: Mapping[str, Any]) -> bool:
    """Verify an RS256 JWT using the RSA public modulus supplied by Cognito.

    Cognito publishes standard RSA JWKs.  Keeping this small verifier in the
    service avoids accepting an unsigned token when a third-party JWT library
    is absent from a minimal runtime image.
    """

    if jwk.get("kty") != "RSA" or jwk.get("alg") not in {None, "RS256"}:
        return False
    modulus = jwk.get("n")
    exponent = jwk.get("e")
    if not isinstance(modulus, str) or not isinstance(exponent, str):
        return False
    try:
        n = int.from_bytes(_decode_base64url(modulus), "big")
        e = int.from_bytes(_decode_base64url(exponent), "big")
    except TokenValidationError:
        return False
    if n <= 0 or e <= 1 or e % 2 == 0:
        return False

    modulus_bytes = (n.bit_length() + 7) // 8
    if len(signature) != modulus_bytes:
        return False
    encoded_message = pow(int.from_bytes(signature, "big"), e, n).to_bytes(modulus_bytes, "big")
    digest_info = _SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(signing_input).digest()
    padding_length = modulus_bytes - len(digest_info) - 3
    if padding_length < 8:
        return False
    expected = b"\x00\x01" + b"\xff" * padding_length + b"\x00" + digest_info
    return hmac.compare_digest(encoded_message, expected)


class CognitoJwtVerifier:
    """Fetch, cache, and verify Cognito's rotating public signing keys."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._issuer = self._build_issuer(settings)
        self._jwks_url = f"{self._issuer}/.well-known/jwks.json"
        self._cached_keys: dict[str, Mapping[str, Any]] = {}
        self._cache_expires_at = 0.0
        self._lock = threading.Lock()

    @staticmethod
    def _build_issuer(settings: Settings) -> str:
        pool_id = settings.cognito_user_pool_id
        region = settings.cognito_region or (pool_id.split("_", 1)[0] if pool_id else None)
        if not pool_id or not region or not settings.cognito_app_client_id:
            raise AuthenticationConfigurationError(
                "Cognito user pool, region, and app client ID must be configured"
            )
        return f"https://cognito-idp.{region}.amazonaws.com/{pool_id}"

    def _load_keys(self, force_refresh: bool = False) -> dict[str, Mapping[str, Any]]:
        with self._lock:
            if (
                self._cached_keys
                and not force_refresh
                and time.monotonic() < self._cache_expires_at
            ):
                return self._cached_keys
            request = Request(self._jwks_url, headers={"Accept": "application/json"})
            try:
                with urlopen(request, timeout=5) as response:  # noqa: S310 - URL is built from deployment config.
                    payload = json.loads(response.read().decode("utf-8"))
            except (URLError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise IdentityProviderUnavailableError(
                    "could not load Cognito signing keys"
                ) from error
            keys = payload.get("keys") if isinstance(payload, dict) else None
            if not isinstance(keys, list):
                raise IdentityProviderUnavailableError("Cognito signing key set is malformed")
            parsed_keys = {
                key["kid"]: key
                for key in keys
                if isinstance(key, dict) and isinstance(key.get("kid"), str)
            }
            if not parsed_keys:
                raise IdentityProviderUnavailableError("Cognito signing key set is empty")
            self._cached_keys = parsed_keys
            self._cache_expires_at = time.monotonic() + self._settings.cognito_jwks_cache_seconds
            return parsed_keys

    def _key_for(self, kid: str) -> Mapping[str, Any]:
        keys = self._load_keys()
        key = keys.get(kid)
        if key is not None:
            return key
        # A missing kid can be a legitimate Cognito key rotation. Refresh once
        # before concluding the token does not belong to this user pool.
        key = self._load_keys(force_refresh=True).get(kid)
        if key is None:
            raise TokenValidationError("JWT signing key is unknown")
        return key

    def verify(self, token: str) -> Principal:
        segments = token.split(".")
        if len(segments) != 3:
            raise TokenValidationError("JWT must contain exactly three segments")
        header = _decode_json_segment(segments[0])
        claims = _decode_json_segment(segments[1])
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise TokenValidationError("JWT must be signed with Cognito RS256 key")
        signature = _decode_base64url(segments[2])
        signing_input = f"{segments[0]}.{segments[1]}".encode("ascii")
        if not _verify_rs256_signature(signing_input, signature, self._key_for(header["kid"])):
            raise TokenValidationError("JWT signature is invalid")
        self._validate_claims(claims)
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise TokenValidationError("JWT subject is missing")
        email = claims.get("email")
        return Principal(
            subject=subject,
            email=email if isinstance(email, str) else None,
            token_use=str(claims["token_use"]),
        )

    def _validate_claims(self, claims: Mapping[str, Any]) -> None:
        if claims.get("iss") != self._issuer:
            raise TokenValidationError("JWT issuer is invalid")
        token_use = self._settings.cognito_token_use
        if token_use not in {"access", "id"}:
            raise AuthenticationConfigurationError("COGNITO_TOKEN_USE must be 'access' or 'id'")
        if claims.get("token_use") != token_use:
            raise TokenValidationError("JWT token use is invalid")
        audience_claim = "client_id" if token_use == "access" else "aud"
        audience = claims.get(audience_claim)
        client_id = self._settings.cognito_app_client_id
        valid_audience = audience == client_id or (
            isinstance(audience, list) and client_id in audience
        )
        if not valid_audience:
            raise TokenValidationError("JWT audience is invalid")

        now = time.time()
        leeway = self._settings.cognito_clock_skew_seconds
        exp = claims.get("exp")
        if not isinstance(exp, (int, float)) or exp < now - leeway:
            raise TokenValidationError("JWT is expired")
        nbf = claims.get("nbf")
        if nbf is not None and (not isinstance(nbf, (int, float)) or nbf > now + leeway):
            raise TokenValidationError("JWT is not active")
        issued_at = claims.get("iat")
        if issued_at is not None and (
            not isinstance(issued_at, (int, float)) or issued_at > now + leeway
        ):
            raise TokenValidationError("JWT issued-at claim is invalid")


@lru_cache
def get_cognito_jwt_verifier() -> CognitoJwtVerifier:
    """Create a verifier for the current process configuration.

    A verifier owns a rotating-key cache. The application's settings are fixed
    for the lifetime of a process, so this dependency is cached as well.
    """

    return CognitoJwtVerifier(get_settings())


async def get_current_principal(
    authorization: str | None = Header(default=None),
    x_repcoach_dev_user: str | None = Header(default=None),
) -> Principal:
    """Return a verified principal or a deliberately restricted dev identity."""

    settings = get_settings()
    if settings.auth_disabled:
        if settings.app_env.lower() not in {"development", "dev", "local", "test"}:
            logger.error(
                "refusing a non-development request because AUTH_DISABLED is enabled app_env=%s",
                settings.app_env,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Authentication is not configured",
            )
        subject = x_repcoach_dev_user or "demo-athlete"
        if not _DEV_SUBJECT_PATTERN.fullmatch(subject):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid development user identifier",
            )
        return Principal(subject=subject, token_use="development")

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer authentication is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token or " " in token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer authentication is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        verifier = get_cognito_jwt_verifier()
        return await asyncio.to_thread(verifier.verify, token)
    except (AuthenticationConfigurationError, IdentityProviderUnavailableError) as error:
        logger.error("authentication provider is unavailable: %s", error)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is temporarily unavailable",
        ) from error
    except TokenValidationError as error:
        logger.info("rejected invalid bearer token: %s", error)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error


def require_user_access(principal: Principal, user_id: str) -> None:
    """Reject attempts to address an athlete other than the authenticated subject."""

    if not hmac.compare_digest(principal.subject, user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this athlete's data",
        )
