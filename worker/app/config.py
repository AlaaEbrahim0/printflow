from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Worker configuration, all overridable via PRINTSHEET_* env vars."""

    model_config = SettingsConfigDict(
        env_prefix="PRINTSHEET_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    service_name: str = "printsheet-worker"
    storage_root: Path = Path("/data/storage")
    api_base_url: str = "http://localhost:8080"
    worker_key: SecretStr = SecretStr("dev-worker-key")
    worker_id: str = "worker-local"
    capabilities: str = "classify,trim,background-removal,upscale,vectorize,resize"
    gpu_enabled: bool = False
    # The GTX 1650 Ti has 4 GB of VRAM. GPU work is deliberately serialized.
    max_gpu_jobs: int = Field(default=1, ge=1, le=1)
    log_level: str = "INFO"

    @property
    def capability_list(self) -> list[str]:
        return [item.strip() for item in self.capabilities.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
