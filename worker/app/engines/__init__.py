"""Adapters around the external image engines.

Every adapter is injectable: processors receive them through
:class:`app.context.JobScope`, so the test suite exercises command construction
and output verification without a GPU, without ``potrace``, without ``vtracer``
and without any model download.
"""

from __future__ import annotations

from app.engines.command import (
    CommandResult,
    CommandRunner,
    SubprocessCommandRunner,
)
from app.engines.cutout import AiCutoutEngine
from app.engines.potrace import PotraceEngine
from app.engines.raster import (
    SvgRasterizer,
    detect_rasterizer,
)
from app.engines.realesrgan import RealesrganEngine
from app.engines.vtracer import VtracerEngine

__all__ = [
    "AiCutoutEngine",
    "CommandResult",
    "CommandRunner",
    "PotraceEngine",
    "RealesrganEngine",
    "SubprocessCommandRunner",
    "SvgRasterizer",
    "VtracerEngine",
    "detect_rasterizer",
]
