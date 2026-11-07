"""AI cutout adapter behind the optional ``rembg`` dependency.

``rembg`` pulls in onnxruntime and downloads its model weights on first use, so
it is deliberately *not* a base dependency (``pip install -e '.[ai]'``). When
the library or the model is missing the job fails with the stable non-retryable
code ``ai-unavailable`` — never a traceback, and never a silent fallback to
key-colour removal, because that would change the visible pixels the operator
asked the AI to decide about.

The calls are guarded with ``ImportError``/``AttributeError``/``TypeError`` so
an unexpected rembg build shows up as a typed failure.
"""

from __future__ import annotations

import importlib
from io import BytesIO
from types import ModuleType

from PIL import Image

from app.config import Settings
from app.errors import AiUnavailableError, EngineFailedError

ENGINE_NAME = "rembg"


class AiCutoutEngine:
    """Segmentation-based background removal (u2net/isnet/birefnet family)."""

    name = ENGINE_NAME

    def __init__(self, settings: Settings, module: ModuleType | None = None) -> None:
        self.settings = settings
        self._module = module

    def load_module(self) -> ModuleType | None:
        if self._module is not None:
            return self._module
        try:
            self._module = importlib.import_module("rembg")
        except ImportError:
            self._module = None
        return self._module

    @property
    def available(self) -> bool:
        module = self.load_module()
        return module is not None and hasattr(module, "remove") and hasattr(module, "new_session")

    def _unavailable(self, model: str, reason: str) -> AiUnavailableError:
        return AiUnavailableError(
            f"AI background removal is unavailable: {reason}",
            details={
                "model": model,
                "install": "pip install 'printsheet-worker[ai]'",
                "setting": "PRINTSHEET_AI_MODEL",
            },
            engine=ENGINE_NAME,
        )

    def cutout(self, image: Image.Image, *, model: str | None = None) -> Image.Image:
        """Return an RGBA cutout of ``image``; the input is never modified."""

        resolved_model = model or self.settings.ai_model
        module = self.load_module()
        if module is None:
            raise self._unavailable(resolved_model, "the rembg package is not installed")
        if not (hasattr(module, "remove") and hasattr(module, "new_session")):
            reason = "the installed rembg build lacks remove()/new_session()"
            raise self._unavailable(resolved_model, reason)

        try:
            session = module.new_session(resolved_model)
        except Exception as exc:  # deliberately broad: model/onnxruntime failures vary
            reason = f"model {resolved_model!r} could not load ({exc})"
            raise self._unavailable(resolved_model, reason) from exc

        try:
            produced = module.remove(image.convert("RGBA"), session=session)
        except TypeError as exc:
            reason = f"rembg.remove() call is incompatible ({exc})"
            raise self._unavailable(resolved_model, reason) from exc
        except Exception as exc:  # inference failure on this input
            raise EngineFailedError(
                f"rembg inference failed: {exc}",
                retryable=False,
                details={"model": resolved_model},
                engine=ENGINE_NAME,
            ) from exc

        if isinstance(produced, Image.Image):
            return produced.convert("RGBA")
        if isinstance(produced, (bytes, bytearray)):
            with Image.open(BytesIO(bytes(produced))) as opened:
                return opened.convert("RGBA")
        raise EngineFailedError(
            "rembg returned an unsupported result type",
            retryable=False,
            details={"model": resolved_model, "type": type(produced).__name__},
            engine=ENGINE_NAME,
        )
