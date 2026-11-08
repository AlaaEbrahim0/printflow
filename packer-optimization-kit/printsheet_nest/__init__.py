"""PrintSheet nesting optimization kit.

A standalone, dependency-light harness for improving the design-packing search.
The production packer in ``../packer`` is the source of truth for the product's
constraints; this kit restates those constraints in a single referee module so
an optimizing agent can iterate quickly without touching the product code.
"""

from __future__ import annotations

__all__ = ["baseline", "cases", "cli", "harness", "referee", "types"]
