"""Testcontainer image parity test against deploy/compose/docker-compose.yml."""

import re
from pathlib import Path

from tests.support.images import PINNED_IMAGES


def test_pinned_images_match_compose() -> None:
    cwd = Path.cwd()
    candidate_paths = [
        cwd / "deploy" / "compose" / "docker-compose.yml",
        cwd.parent.parent / "deploy" / "compose" / "docker-compose.yml",
    ]
    compose_file = next((p for p in candidate_paths if p.is_file()), None)
    assert compose_file is not None, f"docker-compose.yml not found in {candidate_paths}"

    content = compose_file.read_text(encoding="utf-8")

    # Match postgis image
    pg_match = re.search(r"postgis/postgis:[^\s]+", content)
    assert pg_match is not None
    assert pg_match.group(0) == PINNED_IMAGES["postgres"]

    # Match rabbitmq image
    rabbit_match = re.search(r"rabbitmq:[^\s]+", content)
    assert rabbit_match is not None
    assert rabbit_match.group(0) == PINNED_IMAGES["rabbitmq"]
