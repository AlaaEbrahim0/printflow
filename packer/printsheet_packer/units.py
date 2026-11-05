"""Canonical physical-unit conversion.

Mirrors ``PrintSheet.Domain.PrintUnits`` on the API side: every size in the
system rounds through these helpers, never through a local ``round()`` call.
The formula is ``round_half_away_from_zero(cm * dpi / 2.54)``, so 58 cm at
300 DPI is exactly 6850 px.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

CENTIMETERS_PER_INCH = Decimal("2.54")
MILLIMETERS_PER_INCH = Decimal("25.4")

CM_PER_INCH = 2.54
MM_PER_INCH = 25.4


def round_half_away_from_zero(value: float | Decimal) -> int:
    """Round to the nearest integer, ties away from zero."""
    decimal_value = value if isinstance(value, Decimal) else Decimal(repr(float(value)))
    return int(decimal_value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _to_decimal(value: float | int | Decimal) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(repr(float(value)))


def pixels_for_centimeters(centimeters: float | int | Decimal, dpi: int) -> int:
    """``round_half_away_from_zero(cm * dpi / 2.54)``."""
    dpi_decimal = Decimal(dpi)
    return round_half_away_from_zero(_to_decimal(centimeters) * dpi_decimal / CENTIMETERS_PER_INCH)


def pixels_for_millimeters(millimeters: float | int | Decimal, dpi: int) -> int:
    return round_half_away_from_zero(_to_decimal(millimeters) * Decimal(dpi) / MILLIMETERS_PER_INCH)


def ceil_pixels_for_millimeters(millimeters: float | int | Decimal, dpi: int) -> int:
    """Smallest integer pixel count that is not below the requested size.

    Used for clearance requirements (margins, gaps) where rounding down would
    print tighter than the operator asked for.
    """
    exact = _to_decimal(millimeters) * Decimal(dpi) / MILLIMETERS_PER_INCH
    floored = int(exact)
    return floored if Decimal(floored) >= exact else floored + 1


def centimeters_for_pixels(pixels: int | float, dpi: int) -> float:
    """Inverse conversion. Never rounds; the caller decides presentation."""
    return float(_to_decimal(pixels) * CENTIMETERS_PER_INCH / Decimal(dpi))


def millimeters_for_pixels(pixels: int | float, dpi: int) -> float:
    return float(_to_decimal(pixels) * MILLIMETERS_PER_INCH / Decimal(dpi))


__all__ = [
    "CM_PER_INCH",
    "MM_PER_INCH",
    "ceil_pixels_for_millimeters",
    "centimeters_for_pixels",
    "millimeters_for_pixels",
    "pixels_for_centimeters",
    "pixels_for_millimeters",
    "round_half_away_from_zero",
]
