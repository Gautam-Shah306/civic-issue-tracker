"""Application configuration via pydantic-settings for Image Service."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Centralized service settings loaded from environment."""

    SERVICE_NAME: str = "image"
    PORT: int = 8000
    LOG_LEVEL: str = "info"

    DB_HOST: str = "127.0.0.1"
    DB_PORT: int = 5432
    DB_NAME: str = "civic_image"
    DB_USER: str = "civic_image"
    DB_PASSWORD: str = ""

    RABBITMQ_URL: str = "amqp://guest:guest@127.0.0.1:5672"
    JWT_PUBLIC_KEY_B64: str = "MCowBQYDK2VwAyEANkP6YkI1tWJ9n5L9l3q3k7a2v0h4y6u8i0o2p4a6s8d="
    JWT_ISSUER: str = "civic-auth"
    JWT_AUDIENCE: str = "civic-api"
    DELIVERY_LIMIT: int = 5

    S3_ENDPOINT: str = "http://127.0.0.1:8333"
    AWS_ACCESS_KEY_ID: str = "test"
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "us-east-1"
    INCOMING_BUCKET: str = "civic-incoming"
    IMAGES_BUCKET: str = "civic-images"

    MAX_UPLOAD_BYTES: int = 8 * 1024 * 1024  # 8 MiB
    MAX_IMAGE_PIXELS: int = 40_000_000

    WORKER_POLL_INTERVAL: float = 0.5
    WORKER_LEASE_SECONDS: int = 60
    WORKER_MAX_ATTEMPTS: int = 5

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def postgres_dsn(self) -> str:
        """Construct PostgreSQL connection DSN."""
        auth = f"{self.DB_USER}:{self.DB_PASSWORD}@" if self.DB_PASSWORD else f"{self.DB_USER}@"
        return f"postgresql://{auth}{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance."""
    return Settings()
