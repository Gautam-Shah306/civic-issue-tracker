"""Health probe script for container health checks."""

import os
import sys
import urllib.request


def check_health() -> None:
    """Check healthz endpoint on localhost."""
    port = os.getenv("PORT", "8000")
    url = f"http://127.0.0.1:{port}/healthz"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "healthcheck"})
        with urllib.request.urlopen(req, timeout=4) as response:
            if response.status == 200:
                sys.exit(0)
            sys.exit(1)
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    check_health()
