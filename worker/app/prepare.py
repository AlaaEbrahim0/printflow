"""HTTP pixel preparation for the API's background-removal pipeline.

The pipeline needs the *cropped* pixels before it removes a background, and the
*upscaled cropped RGB* after. Both operations already exist as job processors
(``trim`` and ``upscale``); these routes expose the same pure helpers over HTTP
so the API can call them without duplicating auto-crop or the Real-ESRGAN
engines.

Deliberately narrow: one image in, one PNG out, no storage paths, no job
documents, no result envelope. Everything is held in memory (the API already
holds the same bytes), which is fine for one design at a time; see the memory
note in the API's ``BackgroundRemovalPipeline``.
"""

from __future__ import annotations

import asyncio
import io
import secrets
import tempfile
from pathlib import Path

from fastapi import APIRouter, FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse, Response
from PIL import Image

from app.analysis import to_arrays
from app.context import Engines, default_engines
from app.errors import WorkerError
from app.imaging import image_has_alpha
from app.processors.trim import auto_crop_image

CONTENT_TYPE_SUFFIX = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}

router = APIRouter(prefix="/v1")


def _require_worker_key(request: Request, supplied: str | None) -> None:
    expected = request.app.state.prepare_settings.worker_key.get_secret_value()
    if supplied is None or not secrets.compare_digest(supplied, expected):
        raise _PrepareFailure(401, "worker-key-invalid", "X-Worker-Key is missing or wrong.")


class _PrepareFailure(Exception):
    """A client error raised while decoding; rendered as a flat error body."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class _PreparedImage:
    def __init__(self, image: Image.Image, suffix: str) -> None:
        self.image = image
        self.suffix = suffix


def _decode(body: bytes, content_type: str | None, settings) -> _PreparedImage:
    suffix = CONTENT_TYPE_SUFFIX.get((content_type or "").split(";")[0].strip().lower())
    if suffix is None:
        raise _PrepareFailure(
            415, "unsupported-content-type", "Send image/png, image/jpeg or image/webp."
        )
    if not body:
        raise _PrepareFailure(400, "empty-image", "The request body is empty.")
    try:
        image = Image.open(io.BytesIO(body))
        # Check the header before decoding, exactly like the job path: a tiny
        # compressed file can declare an absurd pixel count.
        if image.width * image.height > settings.max_input_pixels:
            raise _PrepareFailure(
                413,
                "input-too-large",
                f"The image is {image.width}x{image.height} px, above the "
                f"{settings.max_input_pixels} px budget.",
            )
        image.load()
    except _PrepareFailure:
        raise
    except Exception as exc:  # noqa: BLE001 - every decoder failure is a 400
        raise _PrepareFailure(
            400, "image-decode-failed", "The image could not be decoded."
        ) from exc
    return _PreparedImage(image, suffix)


def _encode_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _failure(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": code, "message": message})


async def _render_failure(_request: Request, error: Exception) -> JSONResponse:
    """Flat error body for every prepare-route failure, matching ``_failure``."""

    assert isinstance(error, _PrepareFailure)
    return _failure(error.status, error.code, error.message)


def _error_response(error: WorkerError) -> JSONResponse:
    status = 503 if error.code.startswith("engine-") else 400
    return JSONResponse(
        status_code=status,
        content={"code": error.code, "message": error.message, "retryable": error.retryable},
    )


@router.post("/crop", response_class=Response)
async def crop(
    request: Request,
    tolerance: int | None = Query(default=None, ge=0, le=255),
    padding_px: int | None = Query(default=None, alias="paddingPx", ge=0, le=500),
    x_worker_key: str | None = Header(default=None, alias="X-Worker-Key"),
) -> Response:
    """Auto content crop; full-bleed input is returned unchanged with a header."""

    _require_worker_key(request, x_worker_key)
    settings = request.app.state.prepare_settings
    prepared = _decode(await request.body(), request.headers.get("content-type"), settings)
    try:
        outcome = auto_crop_image(
            prepared.image,
            to_arrays(prepared.image),
            settings,
            tolerance=tolerance,
            padding_px=padding_px,
        )
    except WorkerError as error:
        return _error_response(error)

    return Response(
        content=_encode_png(outcome.image),
        media_type="image/png",
        headers={
            "X-Crop-Passthrough": "true" if outcome.passthrough else "false",
            "X-Crop-Warning-Codes": ",".join(
                str(warning.get("code")) for warning in outcome.warnings
            ),
            "X-Image-Width": str(outcome.image.width),
            "X-Image-Height": str(outcome.image.height),
        },
    )


@router.post("/upscale", response_class=Response)
async def upscale(
    request: Request,
    scale: int = Query(ge=2, le=4),
    model: str = Query(default="realesrgan-x4plus"),
    tile_size: int = Query(default=0, alias="tileSize", ge=0),
    gpu: bool = Query(default=False),
    x_worker_key: str | None = Header(default=None, alias="X-Worker-Key"),
) -> Response:
    """Real-ESRGAN on raw bytes. One GPU call at a time per worker."""

    _require_worker_key(request, x_worker_key)
    if scale not in (2, 4):
        return _failure(400, "unsupported-parameters", "scale must be 2 or 4.")
    settings = request.app.state.prepare_settings
    prepared = _decode(await request.body(), request.headers.get("content-type"), settings)
    rgb = _require_rgb(prepared.image)
    if rgb is None:
        # The pipeline supplies the cropped RGB layer; alpha is refined separately.
        return _failure(
            400,
            "alpha-not-supported",
            "The prepare upscaler accepts RGB only; send the cropped RGB layer.",
        )

    engines: Engines = request.app.state.engines
    semaphore: asyncio.Semaphore = request.app.state.upscale_semaphore
    source = rgb

    async with semaphore:
        try:
            output = await asyncio.to_thread(
                _run_upscale,
                engines,
                source,
                prepared.suffix,
                scale,
                model,
                tile_size,
                gpu,
            )
        except WorkerError as error:
            return _error_response(error)

    return Response(
        content=output,
        media_type="image/png",
        headers={
            "X-Image-Width": str(source.width * scale),
            "X-Image-Height": str(source.height * scale),
        },
    )


def _require_rgb(image: Image.Image) -> Image.Image | None:
    """The RGB layer of an image, or ``None`` when it really carries transparency.

    PNG is the pipeline's only transport, so a fully opaque RGBA upload is the
    normal case: its alpha channel is storage, not content. Dropping it keeps the
    upscaler's RGB-only contract honest without rejecting every PNG the cropper
    produces. Real transparency is refused because upscaling it would invent
    edges the separate matte pass is responsible for.
    """

    if not image_has_alpha(image):
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getextrema() != (255, 255):
        return None
    return rgba.convert("RGB")


def _run_upscale(
    engines: Engines,
    image: Image.Image,
    suffix: str,
    scale: int,
    model: str,
    tile_size: int,
    gpu: bool,
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="printsheet-prepare-") as directory:
        root = Path(directory)
        input_path = root / f"input{suffix}"
        output_path = root / "output.png"
        image.save(input_path)
        engines.realesrgan.upscale(
            input_path=input_path,
            output_path=output_path,
            scale=scale,
            model=model,
            tile_size=tile_size,
            gpu=gpu,
        )
        with Image.open(output_path) as produced:
            produced.load()
            if (produced.width, produced.height) != (image.width * scale, image.height * scale):
                raise WorkerError(
                    f"engine returned {produced.width}x{produced.height} instead of "
                    f"{image.width * scale}x{image.height * scale}",
                    code="engine-output-invalid",
                    details={
                        "expectedWidthPx": image.width * scale,
                        "expectedHeightPx": image.height * scale,
                        "actualWidthPx": produced.width,
                        "actualHeightPx": produced.height,
                    },
                )
            return _encode_png(produced)


def install(app: FastAPI, settings, engines: Engines | None = None) -> None:
    """Register the routes and the shared engine bundle on an app instance."""

    app.state.prepare_settings = settings
    app.state.engines = engines or default_engines(settings)
    app.state.upscale_semaphore = asyncio.Semaphore(1)
    app.add_exception_handler(_PrepareFailure, _render_failure)
    app.include_router(router)
