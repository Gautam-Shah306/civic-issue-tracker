"""OpenAPI schema generation test."""

from app.main import app


def test_openapi_schema_generated() -> None:
    schema = app.openapi()
    assert schema["info"]["title"] == "Civic Template Service"
    assert "/healthz" in schema["paths"]
    assert "/api/v1/demo" in schema["paths"]
    assert "/api/v1/demo/protected" in schema["paths"]
