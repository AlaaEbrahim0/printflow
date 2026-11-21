"""The API-facing prepare routes: auth, crop reuse, upscale reuse."""

from __future__ import annotations

import io
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.context import Engines
from app.main import create_app
from tests.conftest import full_bleed_noise, gray_screenshot, make_settings, transparent_sticker

KEY = "dev-worker-key"


class FakeEngine:
    """Writes a nearest-neighbour enlargement and records the call."""

    name = "fake"

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def upscale(self, *, input_path: Path, output_path: Path, scale, model, tile_size, gpu):  # noqa: ANN001
        with Image.open(input_path) as source:
            source.convert("RGB").resize(
                (source.width * scale, source.height * scale), Image.Resampling.NEAREST
            ).save(output_path)
        self.calls.append({"scale": scale, "model": model, "tileSize": tile_size, "gpu": gpu})
        return []


def encode(image: Image.Image, fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


def client(tmp_path: Path, engine: FakeEngine | None = None) -> TestClient:
    settings = make_settings(tmp_path)
    app = create_app(settings, Engines(realesrgan=engine or FakeEngine()))  # type: ignore[arg-type]
    return TestClient(app)


def test_crop_requires_the_worker_key(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        response = test_client.post(
            "/v1/crop", content=encode(gray_screenshot()), headers={"Content-Type": "image/png"}
        )
    assert response.status_code == 401
    assert response.json()["code"] == "worker-key-invalid"


def test_crop_returns_the_same_auto_crop_as_the_trim_job(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        response = test_client.post(
            "/v1/crop",
            content=encode(gray_screenshot()),
            headers={"Content-Type": "image/png", "X-Worker-Key": KEY},
        )

    assert response.status_code == 200
    cropped = Image.open(io.BytesIO(response.content))
    assert cropped.size[0] < 300 and cropped.size[1] < 200
    assert response.headers["X-Crop-Passthrough"] == "false"


def test_crop_reports_full_bleed_without_cutting_it(tmp_path: Path) -> None:
    source = full_bleed_noise()
    with client(tmp_path) as test_client:
        response = test_client.post(
            "/v1/crop",
            content=encode(source),
            headers={"Content-Type": "image/png", "X-Worker-Key": KEY},
        )

    assert response.status_code == 200
    assert response.headers["X-Crop-Passthrough"] == "true"
    assert "full-bleed-no-auto-trim" in response.headers["X-Crop-Warning-Codes"]


def test_crop_rejects_an_absurd_pixel_count(tmp_path: Path) -> None:
    """The header is checked before decoding, exactly like the job path."""

    settings = make_settings(tmp_path, max_input_pixels=100)
    app = create_app(settings, Engines(realesrgan=FakeEngine()))  # type: ignore[arg-type]
    with TestClient(app) as test_client:
        response = test_client.post(
            "/v1/crop",
            content=encode(gray_screenshot()),
            headers={"Content-Type": "image/png", "X-Worker-Key": KEY},
        )

    assert response.status_code == 413
    assert response.json()["code"] == "input-too-large"


def test_crop_rejects_an_unknown_content_type(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        response = test_client.post(
            "/v1/crop",
            content=b"not an image",
            headers={"Content-Type": "text/plain", "X-Worker-Key": KEY},
        )
    assert response.status_code == 415
    assert response.json()["code"] == "unsupported-content-type"


def test_upscale_runs_the_injected_engine_and_returns_png(tmp_path: Path) -> None:
    engine = FakeEngine()
    with client(tmp_path, engine) as test_client:
        response = test_client.post(
            "/v1/upscale?scale=2&model=realesrgan-x4plus",
            content=encode(gray_screenshot()),
            headers={"Content-Type": "image/png", "X-Worker-Key": KEY},
        )

    assert response.status_code == 200
    upscaled = Image.open(io.BytesIO(response.content))
    assert upscaled.size == (600, 400)
    assert engine.calls == [{"scale": 2, "model": "realesrgan-x4plus", "tileSize": 0, "gpu": False}]


def test_upscale_accepts_an_opaque_rgba_png(tmp_path: Path) -> None:
    """The cropper emits RGBA PNGs; an opaque alpha channel is not content."""

    engine = FakeEngine()
    source = gray_screenshot().convert("RGBA")
    with client(tmp_path, engine) as test_client:
        response = test_client.post(
            "/v1/upscale?scale=2",
            content=encode(source),
            headers={"Content-Type": "image/png", "X-Worker-Key": KEY},
        )

    assert response.status_code == 200
    assert Image.open(io.BytesIO(response.content)).size == (600, 400)
    assert engine.calls == [{"scale": 2, "model": "realesrgan-x4plus", "tileSize": 0, "gpu": False}]


def test_upscale_refuses_an_image_that_really_has_transparency(tmp_path: Path) -> None:
    engine = FakeEngine()
    with client(tmp_path, engine) as test_client:
        response = test_client.post(
            "/v1/upscale?scale=2",
            content=encode(transparent_sticker()),
            headers={"Content-Type": "image/png", "X-Worker-Key": KEY},
        )

    assert response.status_code == 400
    assert response.json()["code"] == "alpha-not-supported"
    assert engine.calls == []
