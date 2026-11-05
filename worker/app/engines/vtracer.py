"""``vtracer`` adapter (colour-capable vectorizer).

The call signature below mirrors the official ``vtracer`` 0.6.x stub shipped in
its wheel (``vtracer/vtracer.pyi``):

``convert_image_to_svg_py(image_path, out_path, colormode, hierarchical, mode,
filter_speckle, color_precision, layer_difference, corner_threshold,
length_threshold, max_iterations, splice_threshold, path_precision) -> None``

The contract exposes ``mode``, ``colorCount``, ``turdsize`` and ``threshold``.
``turdsize`` maps directly onto ``filter_speckle`` (minimum blob area in px).
``colorCount`` has no exact vtracer equivalent — ``color_precision`` is a
dwell-depth in bits — so it is mapped to ``ceil(log2(colorCount))`` and the job
carries an ``info`` warning saying the result is approximate.
"""

from __future__ import annotations

import importlib
import math
from pathlib import Path
from types import ModuleType

from app.config import Settings
from app.errors import EngineFailedError, EngineOutputInvalidError, EngineUnavailableError
from app.imaging import make_warning

ENGINE_NAME = "vtracer"
ENTRY_POINT = "convert_image_to_svg_py"
MAX_COLOR_PRECISION = 8


def _color_precision_for(color_count: int) -> int:
    return max(1, min(MAX_COLOR_PRECISION, math.ceil(math.log2(max(color_count, 2)))))


class VtracerEngine:
    """Optional-dependency engine; the module object is injectable for tests."""

    name = ENGINE_NAME

    def __init__(self, settings: Settings, module: ModuleType | None = None) -> None:
        self.settings = settings
        self._module = module

    def load_module(self) -> ModuleType | None:
        if self._module is not None:
            return self._module
        try:
            self._module = importlib.import_module("vtracer")
        except ImportError:
            self._module = None
        return self._module

    @property
    def available(self) -> bool:
        module = self.load_module()
        return module is not None and hasattr(module, ENTRY_POINT)

    def trace_to_svg(
        self,
        *,
        input_path: Path,
        output_path: Path,
        mode: str,
        color_count: int,
        turdsize: int,
    ) -> list[dict]:
        module = self.load_module()
        if module is None or not hasattr(module, ENTRY_POINT):
            raise EngineUnavailableError(
                "the vtracer package is not installed; add it with "
                "pip install -e '.[vector]' or select the potrace engine",
                details={
                    "engine": ENGINE_NAME,
                    "install": "pip install 'printsheet-worker[vector]'",
                },
                engine=ENGINE_NAME,
            )

        convert = getattr(module, ENTRY_POINT)
        warnings: list[dict] = [
            make_warning(
                "color-count-approximated",
                "info",
                f"colorCount {color_count} mapped to vtracer color_precision "
                f"{_color_precision_for(color_count)} (a bit depth, not an exact "
                "palette size).",
                details={"colorCount": color_count},
            )
        ]

        kwargs = {
            "colormode": "binary" if mode == "binary" else "color",
            "filter_speckle": int(max(turdsize, 0)),
            "hierarchical": "stacked",
            "mode": "spline",
        }
        if mode != "binary":
            kwargs["color_precision"] = _color_precision_for(color_count)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            convert(str(input_path), str(output_path), **kwargs)
        except TypeError as exc:
            # A vtracer build with a different signature must not crash the worker.
            raise EngineFailedError(
                f"installed vtracer API is incompatible: {exc}",
                retryable=False,
                details={"engine": ENGINE_NAME},
                engine=ENGINE_NAME,
            ) from exc
        except ValueError as exc:
            raise EngineFailedError(
                f"vtracer could not trace the input: {exc}",
                retryable=False,
                details={"engine": ENGINE_NAME},
                engine=ENGINE_NAME,
            ) from exc

        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise EngineOutputInvalidError(
                "vtracer produced an empty SVG",
                details={"outputPath": str(output_path)},
                engine=ENGINE_NAME,
            )
        return warnings
