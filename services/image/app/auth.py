"""JWT verification and role-based authorization using PyJWT (EdDSA only)."""

import base64
from collections.abc import Callable
from typing import Any

import jwt
from fastapi import Depends, Header
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.errors import AppError


class UserClaims(BaseModel):
    """Authenticated user claims extracted from JWT."""

    id: str
    role: str
    email: str | None = None
    raw_claims: dict[str, Any] = {}

    @property
    def user_id(self) -> str:
        """Alias for id claim."""
        return self.id


class JwtVerifier:
    """EdDSA JWT verifier adhering to D-044 constraints."""

    def __init__(self, settings: Settings) -> None:
        """Initialize with SPKI public key and claims expectations."""
        self.settings = settings
        try:
            raw_bytes = base64.b64decode(settings.JWT_PUBLIC_KEY_B64)
            try:
                decoded_text = raw_bytes.decode("utf-8")
                if "BEGIN PUBLIC KEY" in decoded_text:
                    self.public_key_pem = decoded_text
                else:
                    from cryptography.hazmat.primitives.serialization import (
                        Encoding,
                        PublicFormat,
                        load_der_public_key,
                    )

                    key = load_der_public_key(raw_bytes)
                    self.public_key_pem = key.public_bytes(
                        Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
                    ).decode("utf-8")
            except UnicodeDecodeError:
                from cryptography.hazmat.primitives.serialization import (
                    Encoding,
                    PublicFormat,
                    load_der_public_key,
                )

                key = load_der_public_key(raw_bytes)
                self.public_key_pem = key.public_bytes(
                    Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
                ).decode("utf-8")
        except Exception as e:
            raise RuntimeError(f"Failed to decode JWT_PUBLIC_KEY_B64: {e}") from e

    def verify_token(self, auth_header: str | None) -> UserClaims:
        """Validate bearer token and return user claims."""
        if not auth_header or not auth_header.startswith("Bearer "):
            raise AppError(
                status_code=401,
                code="unauthorized",
                message="Missing or malformed Authorization header",
            )

        token = auth_header[7:].strip()
        if not token:
            raise AppError(
                status_code=401,
                code="unauthorized",
                message="Missing access token",
            )

        try:
            payload = jwt.decode(
                token,
                self.public_key_pem,
                algorithms=["EdDSA"],
                issuer=self.settings.JWT_ISSUER,
                audience=self.settings.JWT_AUDIENCE,
                options={
                    "require": ["exp", "iss", "aud", "sub"],
                    "verify_exp": True,
                },
            )
        except jwt.ExpiredSignatureError as e:
            raise AppError(
                status_code=401,
                code="unauthorized",
                message="Token has expired",
            ) from e
        except jwt.InvalidTokenError as e:
            raise AppError(
                status_code=401,
                code="unauthorized",
                message="Invalid access token",
            ) from e

        sub = payload.get("sub")
        role = payload.get("role")
        if not sub or not role:
            raise AppError(
                status_code=401,
                code="unauthorized",
                message="Token is missing required subject or role claims",
            )

        return UserClaims(
            id=str(sub),
            role=str(role),
            email=payload.get("email"),
            raw_claims=payload,
        )


def get_jwt_verifier(settings: Settings = Depends(get_settings)) -> JwtVerifier:
    """FastAPI dependency for JwtVerifier."""
    return JwtVerifier(settings)


def get_current_user(
    authorization: str | None = Header(None, alias="Authorization"),
    verifier: JwtVerifier = Depends(get_jwt_verifier),
) -> UserClaims:
    """FastAPI dependency returning the verified user claims."""
    return verifier.verify_token(authorization)


def require_role(*allowed_roles: str) -> Callable[[UserClaims], UserClaims]:
    """Create dependency enforcing allowed user roles."""

    def role_checker(user: UserClaims = Depends(get_current_user)) -> UserClaims:
        if user.role not in allowed_roles:
            raise AppError(
                status_code=403,
                code="forbidden",
                message="Insufficient permissions for this operation",
            )
        return user

    return role_checker
