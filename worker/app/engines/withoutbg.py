"""withoutBG open-weights matte adapter.

`withoutbg` (Apache-2.0, built with Meta DINOv3) routes each image to either its
matting graph (fine strands, soft edges, transparency) or a BiRefNet graph (hard
opaque objects). Only one graph runs per image and the alpha is returned at the
source resolution, which is what the mask pipeline wants: the matte becomes the
same 8-bit mask the colour key produces, so grow/contract, feather, mask levels
and brush edits all keep working unchanged.

The import is deliberately lazy. ``withoutbg`` pulls ONNX Runtime and its weights
are ~1.5 GB, so the worker must still start (and serve every non-AI job) when the
package or the model is missing; AI jobs then fail with the stable
``engine-unavailable`` code instead of a stack trace.

Weights resolve in this order: ``PRINTSHEET_CUTOUT_MODEL_PATH`` when the operator
pinned an offline bundle, then the library's own ``WITHOUTBG_MODEL_PATH``, then a
one-time Hugging Face download into the Hub cache.
"""

from __future__ import annotations

import threading

import numpy as np
from PIL import Image

from app.config import Settings
from app.errors import EngineFailedError, EngineUnavailableError

ENGINE_NAME = "withoutbg-open"
MODEL_NAME = "withoutbg-open-weights"

_lock = threading.Lock()
_instance: WithoutBgCutout | None = None

class WithoutBgCutout:
    """One lazily loaded withoutBG model shared by every job in the process."""

    name = ENGINE_NAME

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model = None

    def available(self) -> bool:
        """True when the package is importable; weights may still download."""

        try:
            import withoutbg  # noqa: F401
        except Exception:  # pragma: no cover - depends on install
            return False
        return True

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            from withoutbg import OpenWeightsModel
        except Exception as exc:  # pragma: no cover - depends on install
            raise EngineUnavailableError(
                "The AI cutout needs the `withoutbg` package, which is not installed. "
                "Install it with: pip install -e '.[cutout]'",
                details={"engine": ENGINE_NAME, "package": "withoutbg"},
            ) from exc

        model_path = self.settings.cutout_model_path
        try:
            self._model = OpenWeightsModel(
                model_path=str(model_path) if model_path else None
            )
        except Exception as exc:
            raise EngineUnavailableError(
                f"withoutBG could not open its model bundle: {exc}. Set "
                "PRINTSHEET_CUTOUT_MODEL_PATH to an offline bundle or allow the "
                "one-time Hugging Face download.",
                details={"engine": ENGINE_NAME, "modelPath": str(model_path or "")},
            ) from exc
        return self._model

    def estimate_alpha(self, image: Image.Image) -> Image.Image:
        """Return the model's matte as an ``L`` image at the source resolution."""

        # One inference at a time: the worker already runs one job, and leaving
        # ONNX Runtime to spread across every core while the API serves previews
        # makes the whole workbench feel stuck.
        with _lock:
            model = self._load()
            # Never hand the matte an alpha channel. `convert("RGB")` drops it
            # without compositing, and the RGB under a transparent pixel is
            # undefined (PNG encoders often leave a flat grey), which the model
            # then reads as real artwork. Compositing on white makes the input a
            # normal image; the source alpha is applied afterwards as a cap, so
            # nothing that was hidden can come back as foreground.
            rgb = (
                image
                if image.mode == "RGB"
                else Image.alpha_composite(
                    Image.new("RGBA", image.size, (255, 255, 255, 255)),
                    image.convert("RGBA"),
                ).convert("RGB")
            )
            try:
                alpha = model.estimate_alpha(rgb)
            except Exception as exc:
                raise EngineFailedError(
                    f"withoutBG matte inference failed: {exc}",
                    details={"engine": ENGINE_NAME},
                ) from exc

        if not isinstance(alpha, Image.Image):
            raise EngineFailedError(
                "withoutBG returned no alpha image.",
                details={"engine": ENGINE_NAME, "resultType": type(alpha).__name__},
            )
        if alpha.mode != "L":
            alpha = alpha.convert("L")
        if alpha.size != image.size:
            alpha = alpha.resize(image.size, Image.BILINEAR)
        return alpha

def shared(settings: Settings) -> WithoutBgCutout:
    """The process-wide engine, so the weights load once, not per job."""

    global _instance
    if _instance is None or _instance.settings is not settings:
        _instance = WithoutBgCutout(settings)
    return _instance

def alpha_to_array(alpha: Image.Image, size: tuple[int, int]) -> np.ndarray:
    """Matte as a uint8 array sized ``size`` (width, height)."""

    if alpha.size != size:
        alpha = alpha.resize(size, Image.BILINEAR)
    return np.asarray(alpha.convert("L"), dtype=np.uint8)
