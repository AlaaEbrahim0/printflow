"""Worker configuration.

Everything is overridable through ``PRINTSHEET_*`` environment variables (or a
local ``.env``). No processing rule uses a scattered magic number: sampling
bands, tolerances, padding, DPI warning thresholds, engine paths and timeouts
all come from here, and per-job parameters may override them.
"""

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

    # --- identity / transport ------------------------------------------------
    service_name: str = "printsheet-worker"
    storage_root: Path = Path("/data/storage")
    api_base_url: str = "http://localhost:8080"
    worker_key: SecretStr = SecretStr("dev-worker-key")
    worker_id: str = "worker-local"
    capabilities: str = "image"
    api_timeout_seconds: float = Field(default=15.0, gt=0)
    log_level: str = "INFO"
    log_json: bool = False

    # --- job loop ------------------------------------------------------------
    # Default false: the health endpoint must be testable without an API.
    run_jobs: bool = False
    lease_seconds: int = Field(default=120, ge=15, le=900)
    # Lower bound is small so the sequencing can be exercised in tests.
    heartbeat_seconds: float = Field(default=30.0, ge=0.05, le=600)
    poll_seconds: float = Field(default=2.0, ge=0.1, le=60)
    claim_backoff_seconds: float = Field(default=5.0, ge=0.1, le=120)
    max_consecutive_claim_errors: int = Field(default=5, ge=1)
    # SIGTERM/SIGINT grace for the job already in flight before it is failed.
    shutdown_grace_seconds: float = Field(default=30.0, gt=0)

    # --- GPU -----------------------------------------------------------------
    gpu_enabled: bool = False
    # The GTX 1650 Ti has 4 GB of VRAM. GPU work is deliberately serialized.
    max_gpu_jobs: int = Field(default=1, ge=1, le=1)

    # --- contracts -----------------------------------------------------------
    # Explicit directory holding ``jsonschema/*.schema.json``. When unset the
    # worker searches upward from its own package for ``contracts/jsonschema``
    # and finally falls back to the copy vendored inside the package.
    contracts_dir: Path | None = None

    # --- image rules ---------------------------------------------------------
    working_dpi: int = Field(default=300, ge=72, le=1200)
    dpi_warn_below: int = Field(default=150, ge=1)
    dpi_strong_warn_below: int = Field(default=100, ge=1)
    # Decompression-bomb / intake guard for the worker's own reads.
    max_input_pixels: int = Field(default=80_000_000, ge=1)

    # Border sampling used by classify and auto-trim. The band is
    # clamp(round(min(w, h) * ratio), min, max) pixels wide.
    border_band_ratio: float = Field(default=0.04, gt=0, le=0.5)
    border_band_min_px: int = Field(default=2, ge=1)
    border_band_max_px: int = Field(default=48, ge=1)
    # A pixel within this per-channel distance of the background is background.
    background_match_tolerance: int = Field(default=12, ge=0, le=255)
    alpha_threshold: int = Field(default=5, ge=0, le=255)
    edge_uniform_ratio: float = Field(default=0.9, gt=0, le=1)

    # Classifier analysis: colour/edge features are computed on a downscaled
    # copy whose longest side is at most this many pixels.
    classify_analysis_max_px: int = Field(default=600, ge=64, le=4096)
    classify_color_levels: int = Field(default=32, ge=2, le=256)
    classify_flat_color_tolerance: int = Field(default=12, ge=0, le=255)
    classify_edge_threshold: int = Field(default=48, ge=1, le=255)
    classify_unique_color_logo_max: int = Field(default=48, ge=1)
    classify_trim_margin_ratio: float = Field(default=0.02, ge=0, le=0.5)

    # Auto-trim defaults used when the job omits paddingPx / tolerance.
    trim_padding_px: int = Field(default=8, ge=0, le=10000)
    trim_tolerance: int = Field(default=12, ge=0, le=255)

    # --- cutout (background removal) -----------------------------------------
    # BiRefNet weights live outside the image; when the file is missing the job
    # fails with a stable engine-unavailable error instead of substituting a model.
    cutout_model_dir: Path = Path("/models/cutout")
    # One 1024x1024 forward pass covers this many source pixels. Native scale (1024)
    # is slowest and best; 1200 measured as the point where quality saturates.
    cutout_tile_source_px: int = Field(default=1200, ge=256, le=8192)
    cutout_tile_overlap_px: int = Field(default=96, ge=0, le=2048)
    # Hard ceiling so a huge design cannot queue hundreds of forward passes.
    cutout_max_tiles: int = Field(default=64, ge=1, le=4096)
    cutout_cpu_threads: int = Field(default=0, ge=0, le=256)
    cutout_timeout_seconds: int = Field(default=3600, ge=1)

    # --- engines -------------------------------------------------------------
    realesrgan_binary: Path = Path("realesrgan-ncnn-vulkan")
    realesrgan_model_dir: Path | None = None
    realesrgan_tile_size: int = Field(default=256, ge=0, le=8192)
    realesrgan_gpu_device_index: int = Field(default=0, ge=-1, le=16)
    realesrgan_cpu_threads: int = Field(default=0, ge=0, le=64)
    realesrgan_timeout_seconds: int = Field(default=900, ge=1)

    @property
    def capability_list(self) -> list[str]:
        capabilities = [item.strip() for item in self.capabilities.split(",") if item.strip()]
        if not self.gpu_enabled:
            capabilities = [item for item in capabilities if item != "gpu"]
        elif "gpu" not in capabilities:
            capabilities.append("gpu")
        return capabilities

    @property
    def border_band_settings(self) -> tuple[float, int, int]:
        return (self.border_band_ratio, self.border_band_min_px, self.border_band_max_px)


@lru_cache
def get_settings() -> Settings:
    return Settings()
