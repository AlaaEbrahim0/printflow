"""upscale: Real-ESRGAN through the ncnn Vulkan binary, never a silent substitute.

The adapter verifies the two things that actually matter to the shop: that a
file was produced and that it is **exactly** ``scale`` times the input in both
axes. A binary that quietly returned the input unscaled, or an anime model
mismatch, would otherwise let a design reach the packer at the wrong physical
size.

``engine-unavailable`` is non-retryable: re-queuing a job cannot make an absent
binary appear. Only an engine that ran and crashed is treated as retryable.
"""

from __future__ import annotations

from typing import Any

from PIL import Image

from app.context import JobScope
from app.engines.realesrgan import ENGINE_INPUT_SUFFIXES, ENGINE_NAME
from app.errors import (
    EngineOutputInvalidError,
    UnsupportedParameterError,
)
from app.imaging import (
    build_metadata,
    dpi_warnings,
    effective_dpi_at_target,
    image_has_alpha,
    make_warning,
)
from app.job_models import WorkerJob

ALLOWED_MODELS = ("realesrgan-x4plus", "realesrgan-x4plus-anime")
ALLOWED_SCALES = (2, 4)


def _engine_readable_input(
    job: WorkerJob, scope: JobScope, image: Image.Image
) -> tuple[str, Image.Image, list[dict[str, Any]]]:
    """Return the relative path the binary should read, converting if needed.

    ``realesrgan-ncnn-vulkan`` only accepts png/jpg/webp. A source stored under a
    different name (or a mode it cannot decode) is written once into the job's
    own scratch folder as PNG; the original file is never touched.
    """

    original_absolute = scope.storage.resolve(job.input_path)
    if original_absolute.suffix.lower() in ENGINE_INPUT_SUFFIXES:
        return job.input_path, image, []
    scratch = scope.scratch(f"{job.job_id}-engine-input.png")
    converted = image.convert("RGBA") if image_has_alpha(image) else image.convert("RGB")
    converted.save(scratch.absolute, format="PNG", optimize=True)
    warning = make_warning(
        "engine-input-converted",
        "info",
        f"Source suffix {original_absolute.suffix or '<none>'} is not readable by "
        "realesrgan-ncnn-vulkan; a scratch PNG copy was used.",
        details={"inputPath": job.input_path},
    )
    return scratch.relative, converted, [warning]


def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    if job.type != "upscale":
        raise UnsupportedParameterError(
            "upscale processor cannot run this job", details={"jobType": job.type}
        )

    settings = scope.settings
    model = str(job.param("model", ""))
    if model not in ALLOWED_MODELS:
        raise UnsupportedParameterError(
            f"unsupported upscale model {model!r}", details={"supported": list(ALLOWED_MODELS)}
        )
    scale = int(job.param("scale", 0))
    if scale not in ALLOWED_SCALES:
        raise UnsupportedParameterError(
            f"unsupported upscale scale {scale!r}", details={"supported": list(ALLOWED_SCALES)}
        )
    tile_size = job.param_int("tileSize", settings.realesrgan_tile_size)
    gpu = job.param_bool("gpu", False)

    source = scope.open_input()
    warnings: list[dict[str, Any]] = list(source.warnings)
    input_relative, image_for_engine, conversion_warnings = _engine_readable_input(
        job, scope, source.image
    )
    warnings.extend(conversion_warnings)

    input_absolute = scope.storage.resolve(input_relative)
    staged = scope.scratch(f"{job.job_id}-upscaled.png")

    engine_warnings = scope.engines.realesrgan.upscale(
        input_path=input_absolute,
        output_path=staged.absolute,
        scale=scale,
        model=model,
        tile_size=tile_size,
        gpu=gpu,
    )
    warnings.extend(engine_warnings)

    with Image.open(staged.absolute) as produced:
        produced.load()
        produced.copy()  # force a full decode before we trust the numbers
        if produced.width != image_for_engine.width * scale or (
            produced.height != image_for_engine.height * scale
        ):
            raise EngineOutputInvalidError(
                f"realesrgan-ncnn-vulkan returned {produced.width}x{produced.height} "
                f"instead of the expected {image_for_engine.width * scale}x"
                f"{image_for_engine.height * scale}",
                details={
                    "expectedWidthPx": image_for_engine.width * scale,
                    "expectedHeightPx": image_for_engine.height * scale,
                    "actualWidthPx": produced.width,
                    "actualHeightPx": produced.height,
                },
                engine=ENGINE_NAME,
            )
        alpha_before = image_has_alpha(image_for_engine)
        alpha_after = image_has_alpha(produced)
        if alpha_before and not alpha_after:
            warnings.append(
                make_warning(
                    "alpha-dropped-by-engine",
                    "warning",
                    "The source carried transparency but the engine output has none; "
                    "review the preview before approving — background removal may be "
                    "needed again after the upscale.",
                    details={"engine": ENGINE_NAME},
                )
            )
        result_image = produced.copy()

    output_relative = job.require_output_path()
    output_absolute = scope.storage.resolve(output_relative)
    if output_absolute.suffix.lower() == ".png":
        # Byte-exact promotion: no second encode of the restored pixels.
        scope.storage.promote(staged.relative, output_relative, scope.protected)
    else:
        warnings.extend(scope.save_image(output_relative, result_image))

    effective_dpi = effective_dpi_at_target(
        image_for_engine.width,
        image_for_engine.height,
        job.context.target_width_cm,
        job.context.target_height_cm,
    )
    warnings.extend(dpi_warnings(effective_dpi, settings))

    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "outputPath": output_relative,
        "metadata": build_metadata(
            result_image,
            duration_ms=0,
            engine=ENGINE_NAME,
            model=model,
            effective_dpi=effective_dpi,
            warnings=warnings,
            has_alpha=image_has_alpha(result_image),
        ),
    }
