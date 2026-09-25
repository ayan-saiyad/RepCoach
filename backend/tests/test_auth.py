"""Access-control and health-probe contracts independent of a live database."""

from collections.abc import Iterator
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.routes import health
from app.core import auth
from app.core.auth import Principal, get_current_principal, require_user_access
from app.core.config import get_settings


def protected_client() -> TestClient:
    app = FastAPI()
    PrincipalDep = Annotated[Principal, Depends(get_current_principal)]

    @app.get("/athletes/{user_id}")
    async def athlete_data(user_id: str, principal: PrincipalDep) -> dict[str, str]:
        require_user_access(principal, user_id)
        return {"user_id": user_id}

    return TestClient(app)


@pytest.fixture
def cognito_auth_enabled(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    verifier_factory = auth.get_cognito_jwt_verifier
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AUTH_DISABLED", "false")
    monkeypatch.setenv("COGNITO_REGION", "us-east-1")
    monkeypatch.setenv("COGNITO_USER_POOL_ID", "us-east-1_example")
    monkeypatch.setenv("COGNITO_APP_CLIENT_ID", "example-client")
    get_settings.cache_clear()
    verifier_factory.cache_clear()
    yield
    verifier_factory.cache_clear()
    get_settings.cache_clear()


def test_protected_route_requires_bearer_authentication(cognito_auth_enabled: None) -> None:
    response = protected_client().get("/athletes/athlete-a")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_authenticated_principal_cannot_access_another_athlete(
    cognito_auth_enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    class StubVerifier:
        def verify(self, token: str) -> Principal:
            assert token == "verified-token"
            return Principal(subject="athlete-a")

    monkeypatch.setattr(auth, "get_cognito_jwt_verifier", lambda: StubVerifier())

    response = protected_client().get(
        "/athletes/athlete-b", headers={"Authorization": "Bearer verified-token"}
    )

    assert response.status_code == 403


def test_authenticated_principal_can_access_own_data(
    cognito_auth_enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    class StubVerifier:
        def verify(self, _: str) -> Principal:
            return Principal(subject="athlete-a")

    monkeypatch.setattr(auth, "get_cognito_jwt_verifier", lambda: StubVerifier())

    response = protected_client().get(
        "/athletes/athlete-a", headers={"Authorization": "Bearer verified-token"}
    )

    assert response.status_code == 200
    assert response.json() == {"user_id": "athlete-a"}


def test_production_fails_closed_when_development_auth_is_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    get_settings.cache_clear()
    try:
        response = protected_client().get("/athletes/demo-athlete")
        assert response.status_code == 503
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_livez_is_dependency_free() -> None:
    payload = await health.livez()

    assert payload["status"] == "live"


@pytest.mark.asyncio
async def test_readyz_checks_database_and_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def database_ready() -> None:
        calls.append("database")

    async def cache_ready() -> None:
        calls.append("cache")

    monkeypatch.setattr(health, "check_database_connection", database_ready)
    monkeypatch.setattr(health, "check_cache_connection", cache_ready)

    payload = await health.readyz()

    assert payload["status"] == "ready"
    assert calls == ["database", "cache"]


@pytest.mark.asyncio
async def test_readyz_returns_service_unavailable_for_a_failed_dependency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def database_ready() -> None:
        return None

    async def cache_down() -> None:
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(health, "check_database_connection", database_ready)
    monkeypatch.setattr(health, "check_cache_connection", cache_down)

    with pytest.raises(HTTPException) as error:
        await health.readyz()

    assert error.value.status_code == 503
