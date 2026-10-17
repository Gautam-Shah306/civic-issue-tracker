"""OpenAPI specification drift test for image service."""

import json
from pathlib import Path

from app.main import app


def test_openapi_contract_drift() -> None:
    """Ensure generated OpenAPI matches contracts/openapi/image.v1.openapi.json."""
    contract_path = (
        Path(__file__).resolve().parents[3] / "contracts" / "openapi" / "image.v1.openapi.json"
    )
    assert contract_path.exists(), f"Contract file missing at {contract_path}"

    with open(contract_path, encoding="utf-8") as f:
        committed_schema = json.load(f)

    generated_schema = app.openapi()

    assert generated_schema == committed_schema, (
        "OpenAPI specification has drifted from contracts/openapi/image.v1.openapi.json! "
        "Update the contract file or fix image routes to resolve."
    )
