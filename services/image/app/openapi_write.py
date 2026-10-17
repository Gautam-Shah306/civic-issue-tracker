"""Export OpenAPI schema for image service to contracts/openapi/image.v1.openapi.json."""

import json
from pathlib import Path

from app.main import app


def export_openapi() -> None:
    """Export image service OpenAPI schema to contracts directory."""
    schema = app.openapi()
    repo_root = Path(__file__).resolve().parents[3]
    contract_path = repo_root / "contracts" / "openapi" / "image.v1.openapi.json"
    contract_path.parent.mkdir(parents=True, exist_ok=True)
    with open(contract_path, "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2)
        f.write("\n")
    print(f"Exported OpenAPI spec to {contract_path}")


if __name__ == "__main__":
    export_openapi()
