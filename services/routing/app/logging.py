"""Structured JSON logging with correlation ID propagation."""

import contextvars
import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

correlation_id_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "correlation_id", default=None
)


class JsonFormatter(logging.Formatter):
    """Format log records as single-line JSON objects."""

    def __init__(self, service_name: str) -> None:
        """Initialize formatter with owning service name."""
        super().__init__()
        self.service_name = service_name

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON string."""
        log_entry: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": self.service_name,
            "logger": record.name,
            "message": record.getMessage(),
        }

        cid = correlation_id_ctx.get()
        if cid:
            log_entry["correlationId"] = cid

        if record.exc_info and record.exc_text:
            log_entry["exception"] = record.exc_text

        return json.dumps(log_entry, default=str)


def setup_logging(service_name: str = "routing", log_level: str = "info") -> logging.Logger:
    """Configure root and application loggers to emit JSON to stdout."""
    level = getattr(logging, log_level.upper(), logging.INFO)

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(JsonFormatter(service_name))
    root_logger.addHandler(stream_handler)

    return logging.getLogger(service_name)
