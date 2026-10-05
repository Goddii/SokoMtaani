# Playwright API Test Fixture
# Place in tests/api/conftest.py or tests/api/fixtures.py

import os
import pytest
from playwright.async_api import async_playwright


# Configuration via environment variables
BASE_URL = os.getenv("API_BASE_URL", "http://localhost:3000")
AUTH_TOKEN = os.getenv("API_AUTH_TOKEN", "")
TEST_USER_EMAIL = os.getenv("API_TEST_USER_EMAIL", "test@example.com")
TEST_USER_PASSWORD = os.getenv("API_TEST_USER_PASSWORD", "testpass")


@pytest.fixture(scope="session")
def api_base_url():
    """Base URL for API under test."""
    return BASE_URL


@pytest.fixture(scope="session")
def auth_token():
    """Pre-authenticated token (if available)."""
    return AUTH_TOKEN


@pytest.fixture(scope="session")
async def api_context(api_base_url, auth_token):
    """
    Playwright APIRequestContext for authenticated requests.
    Automatically handles base URL and auth headers.
    """
    async with async_playwright() as p:
        context = await p.request.new_context(
            base_url=api_base_url,
            extra_http_headers={
                "Authorization": f"Bearer {auth_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            } if auth_token else {
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )
        yield context
        await context.dispose()


@pytest.fixture(scope="session")
async def api_context_unauth(api_base_url):
    """Unauthenticated context for testing auth requirements."""
    async with async_playwright() as p:
        context = await p.request.new_context(
            base_url=api_base_url,
            extra_http_headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )
        yield context
        await context.dispose()


@pytest.fixture(scope="function")
async def authenticated_context(api_context_unauth):
    """
    Creates a freshly authenticated context per test.
    Use when tests need isolated auth state.
    """
    # Login
    response = await api_context_unauth.post("/auth/login", data={
        "email": TEST_USER_EMAIL,
        "password": TEST_USER_PASSWORD,
    })
    assert response.status == 200, f"Login failed: {await response.text()}"
    data = await response.json()
    token = data.get("token") or data.get("access_token")
    assert token, "No token in login response"
    
    # Create new context with token
    async with async_playwright() as p:
        context = await p.request.new_context(
            base_url=BASE_URL,
            extra_http_headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )
        yield context
        await context.dispose()


# Helper functions for common assertions
async def assert_response_ok(response, expected_status=200):
    """Assert response status and return parsed JSON."""
    assert response.status == expected_status, \
        f"Expected {expected_status}, got {response.status}: {await response.text()}"
    return await response.json()


async def assert_validation_error(response, field=None):
    """Assert 400 with validation error structure."""
    assert response.status == 400
    error = await response.json()
    assert "errors" in error or "detail" in error
    if field:
        error_text = str(error)
        assert field in error_text, f"Expected field '{field}' in validation error"
    return error


async def assert_not_found(response):
    """Assert 404 response."""
    assert response.status == 404
    return await response.json()


async def assert_unauthorized(response):
    """Assert 401 response."""
    assert response.status == 401
    return await response.json()


async def assert_forbidden(response):
    """Assert 403 response."""
    assert response.status == 403
    return await response.json()


# Test data factories
def user_factory(**overrides):
    """Generate valid user payload."""
    import uuid
    from datetime import datetime
    base = {
        "name": f"Test User {uuid.uuid4().hex[:8]}",
        "email": f"test-{uuid.uuid4().hex[:8]}@example.com",
        "role": "user",
    }
    base.update(overrides)
    return base


def invalid_user_factory(**overrides):
    """Generate invalid user payload for validation testing."""
    base = {
        "name": "",  # Empty name
        "email": "not-an-email",
        "role": "invalid_role",
    }
    base.update(overrides)
    return base