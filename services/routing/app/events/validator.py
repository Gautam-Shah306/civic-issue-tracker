"""JSON Schema validator for domain events using Draft 2020-12."""

import json
from pathlib import Path
from typing import Any

import jsonschema
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012


class EventValidator:
    """Validate event envelopes and payloads against canonical schemas."""

    def __init__(self, schemas_dir: Path | None = None) -> None:
        """Initialize validator and compile all discovered event schemas."""
        self.schemas_dir = schemas_dir or self._find_schemas_dir()
        self.schemas: dict[str, dict[str, Any]] = {}
        self.validators: dict[str, jsonschema.Draft202012Validator] = {}
        self._load_schemas()

    @staticmethod
    def _find_schemas_dir() -> Path:
        cwd = Path.cwd()
        candidate_dirs = [
            cwd / "contracts" / "events",
            cwd.parent.parent / "contracts" / "events",
            Path(__file__).parent.parent.parent.parent.parent / "contracts" / "events",
            Path("/app/contracts/events"),
        ]
        for d in candidate_dirs:
            if d.is_dir() and (d / "envelope.v1.schema.json").is_file():
                return d.resolve()
        err_msg = f"Contracts events directory not found in candidate paths: {candidate_dirs}"
        raise FileNotFoundError(err_msg)

    def _load_schemas(self) -> None:
        raw_schemas: dict[str, dict[str, Any]] = {}
        for schema_file in self.schemas_dir.glob("*.schema.json"):
            content = json.loads(schema_file.read_text(encoding="utf-8"))
            schema_id = content.get("$id", schema_file.name)
            raw_schemas[schema_id] = content
            raw_schemas[schema_file.name] = content

        registry: Registry = Registry()
        for sid, sdata in raw_schemas.items():
            resource = Resource.from_contents(sdata, default_specification=DRAFT202012)
            registry = registry.with_resource(sid, resource)

        for filename, sdata in raw_schemas.items():
            if filename.endswith(".schema.json"):
                validator = jsonschema.Draft202012Validator(sdata, registry=registry)
                self.validators[filename] = validator
                self.schemas[filename] = sdata

    def validate_envelope(self, data: dict[str, Any]) -> None:
        """Validate envelope structure."""
        validator = self.validators.get("envelope.v1.schema.json")
        if not validator:
            raise RuntimeError("Envelope schema envelope.v1.schema.json is not loaded")
        validator.validate(data)

    def validate_event(self, event_type: str, version: int, data: dict[str, Any]) -> None:
        """Validate an event against its schema."""
        self.validate_envelope(data)
        schema_name = f"{event_type}.v{version}.schema.json"
        validator = self.validators.get(schema_name)
        if not validator:
            raise ValueError(f"Schema {schema_name} not found for eventType={event_type}")
        validator.validate(data)


_global_validator: EventValidator | None = None


def get_event_validator() -> EventValidator:
    """Retrieve singleton EventValidator instance."""
    global _global_validator
    if _global_validator is None:
        _global_validator = EventValidator()
    return _global_validator
