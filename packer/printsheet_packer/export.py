"""Placements manifest and the export writers.

The frozen contracts do not define an export request, so the manifest is the
packer's own documented artifact: it carries everything a render needs (sheet
geometry, request parameters, per placement source path, hashes, cm and px
geometry and rotation) and is validated on read.

Guaranteed formats (ADR 0003): flat PNG, flat TIFF, and the ``psd-bundle`` of
flat PNG + manifest + Photoshop ``.jsx`` rebuild script. True layered PSD/PSB
is refused rather than faked.
"""

from __future__ import annotations

import hashlib
import json
import struct
import zlib
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from printsheet_packer.contracts import (
    INTEGRITY_REPORT,
    ContractStore,
    PackRequest,
    sheet_geometry,
    utc_timestamp,
)
from printsheet_packer.errors import (
    ContractValidationError,
    ExportFormatUnavailableError,
    MissingSourceError,
    PackerError,
)
from printsheet_packer.masks import load_rgba
from printsheet_packer.nesting import Layout
from printsheet_packer.render import RenderPlacement, SheetRenderer
from printsheet_packer.storage import StorageRoot, atomic_write_binary

MANIFEST_KIND = "printsheet.packer.manifest"
MANIFEST_VERSION = "1.0"

FLAT_PNG = "flat-png"
FLAT_TIFF = "flat-tiff"
PSD_BUNDLE = "psd-bundle"
AVAILABLE_FORMATS = (FLAT_PNG, FLAT_TIFF, PSD_BUNDLE)
REFUSED_FORMATS = ("layered-psd", "layered-psb")
ALL_FORMATS = AVAILABLE_FORMATS + REFUSED_FORMATS

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def manifest_schema_path() -> Path:
    return Path(__file__).resolve().parent / "schemas" / "placement-manifest.schema.json"


def _manifest_validator() -> Any:
    from jsonschema import Draft202012Validator

    schema = json.loads(manifest_schema_path().read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


# ----------------------------------------------------------------------
# building
# ----------------------------------------------------------------------


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_manifest(
    request: PackRequest,
    layout: Layout,
    report: dict[str, Any],
    sources: dict[str, tuple[str, str]],
) -> dict[str, Any]:
    """Assemble the manifest. ``sources`` maps designId to (relativePath, sha256)."""
    from printsheet_packer.units import centimeters_for_pixels

    placements = []
    for placed in layout.placed:
        design = placed.candidate.design
        file_path, digest = sources[design.design_id]
        footprint = placed.footprint
        x_cm = centimeters_for_pixels(placed.x_px, request.dpi)
        y_cm = centimeters_for_pixels(placed.y_px, request.dpi)
        entry: dict[str, Any] = {
            "designId": design.design_id,
            "versionId": design.version_id,
            "filePath": file_path,
            "sha256": digest,
            "sourceWidthPx": design.width_px,
            "sourceHeightPx": design.height_px,
            "rotationDeg": placed.rotation_deg,
            "xPx": placed.x_px,
            "yPx": placed.y_px,
            "widthPx": footprint.image_width_px,
            "heightPx": footprint.image_height_px,
            "xCm": x_cm,
            "yCm": y_cm,
            "widthCm": centimeters_for_pixels(footprint.image_width_px, request.dpi),
            "heightCm": centimeters_for_pixels(footprint.image_height_px, request.dpi),
            "visibleX0Px": placed.visible_bbox_px.x0,
            "visibleY0Px": placed.visible_bbox_px.y0,
            "visibleX1Px": placed.visible_bbox_px.x1,
            "visibleY1Px": placed.visible_bbox_px.y1,
        }
        if design.display_name:
            entry["displayName"] = design.display_name
        placements.append(entry)

    return {
        "schemaVersion": MANIFEST_VERSION,
        "kind": MANIFEST_KIND,
        "requestId": request.request_id,
        "generatedAt": utc_timestamp(),
        "sheet": sheet_geometry(layout.sheet_width_px, layout.sheet_height_px, request.dpi),
        "parameters": {
            "rollWidthCm": request.roll_width_cm,
            "marginMm": request.margin_mm,
            "edgeMarginMm": request.edge_margin_mm,
            "dpi": request.dpi,
            "alphaThreshold": request.alpha_threshold,
            "cellMm": request.cell_mm,
            "cellPx": layout.cell_px,
            "seed": request.seed,
            "randomizedOrderings": request.randomized_orderings,
            "orderingsTried": layout.orderings_tried,
            "timeBudgetMs": request.time_budget_ms,
            "noInterlocking": request.no_interlocking,
        },
        "placements": placements,
        "integrityReport": report,
    }


def write_manifest(
    root: StorageRoot, relative_path: str, manifest: dict[str, Any], *, overwrite: bool = False
) -> Path:
    require_manifest_valid(manifest)
    target = root.resolve(relative_path, field="output.manifestPath")
    return root.write_json(target, manifest, overwrite=overwrite)


def read_manifest(path: Path | str) -> dict[str, Any]:
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    require_manifest_valid(document)
    return document


def _describe(error: Any) -> str:
    location = "/".join(str(part) for part in error.absolute_path) or "<root>"
    return f"{location}: {error.message}"


def require_manifest_valid(document: dict[str, Any]) -> None:
    errors = sorted(
        _manifest_validator().iter_errors(document), key=lambda error: list(error.absolute_path)
    )
    if errors:
        raise ContractValidationError(
            "placements manifest is not valid",
            errors=[_describe(error) for error in errors],
        )
    report_errors = ContractStore().validate(INTEGRITY_REPORT, document["integrityReport"])
    if report_errors:
        raise ContractValidationError(
            "manifest integrity report is not valid against the frozen contract",
            errors=report_errors,
        )


# ----------------------------------------------------------------------
# rendering bridge
# ----------------------------------------------------------------------


@dataclass(frozen=True)
class SheetSpec:
    """Everything an exporter needs, read out of a validated manifest."""

    width_px: int
    height_px: int
    dpi: int
    alpha_threshold: int
    placements: tuple[RenderPlacement, ...]
    report_id: str
    manifest: dict[str, Any]

    @classmethod
    def from_manifest(cls, manifest: dict[str, Any]) -> SheetSpec:
        require_manifest_valid(manifest)
        sheet = manifest["sheet"]
        placements = tuple(
            RenderPlacement(
                design_id=entry["designId"],
                x_px=entry["xPx"],
                y_px=entry["yPx"],
                width_px=entry["widthPx"],
                height_px=entry["heightPx"],
                rotation_deg=entry["rotationDeg"],
            )
            for entry in manifest["placements"]
        )
        return cls(
            width_px=sheet["widthPx"],
            height_px=sheet["heightPx"],
            dpi=sheet["dpi"],
            alpha_threshold=manifest["parameters"]["alphaThreshold"],
            placements=placements,
            report_id=manifest["integrityReport"]["reportId"],
            manifest=manifest,
        )


def renderer_for(spec: SheetSpec, root: StorageRoot) -> SheetRenderer:
    return SheetRenderer(
        spec.width_px, spec.height_px, spec.placements, source_loader(root, spec.manifest)
    )


# ----------------------------------------------------------------------
# PNG
# ----------------------------------------------------------------------


def _chunk(stream: Any, kind: bytes, payload: bytes) -> None:
    stream.write(struct.pack(">I", len(payload)))
    stream.write(kind)
    stream.write(payload)
    stream.write(struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))


def pixels_per_metre(dpi: int) -> int:
    """PNG pHYs wants micrometres per pixel; 300 DPI becomes 11811 px/m."""
    return (dpi * 1_000_000 + 12_700) // 25_400


def write_flat_png(
    manifest: dict[str, Any],
    storage_root: StorageRoot | str | Path,
    out_path: Path | str,
    *,
    strip_rows: int = 512,
    compression_level: int = 6,
    overwrite: bool = False,
) -> Path:
    """Stream an 8-bit RGBA PNG of the whole sheet without allocating it."""
    root = _as_root(storage_root)
    spec = SheetSpec.from_manifest(manifest)
    renderer = renderer_for(spec, root)
    destination = root.guard_output(out_path, overwrite=overwrite)
    width, height = spec.width_px, spec.height_px
    ppm = pixels_per_metre(spec.dpi)

    with atomic_write_binary(destination) as stream:
        stream.write(PNG_SIGNATURE)
        _chunk(stream, b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        _chunk(stream, b"pHYs", struct.pack(">IIB", ppm, ppm, 1))
        _chunk(stream, b"tEXt", b"PrintSheet-Report\x00" + spec.report_id.encode("ascii"))
        # PNG transports a zlib stream (RFC 1950), not a raw deflate stream.
        compressor = zlib.compressobj(compression_level, zlib.DEFLATED, zlib.MAX_WBITS)
        rows_written = 0
        for _, _, band in renderer.iter_strips(strip_rows):
            rows_written += band.shape[0]
            payload = _prefixed_rows(band)
            blob = compressor.compress(payload)
            if blob:
                _chunk(stream, b"IDAT", blob)
        if rows_written != height:
            raise PackerError(f"PNG wrote {rows_written} rows for a {height} row sheet")
        tail = compressor.flush()
        if tail:
            _chunk(stream, b"IDAT", tail)
        _chunk(stream, b"IEND", b"")
    return destination


def _prefixed_rows(band: np.ndarray) -> bytes:
    """Each scanline with filter type 0 in front, as PNG requires."""
    buffer = bytearray()
    for row in band.reshape(band.shape[0], -1):
        buffer.append(0)
        buffer += row.tobytes()
    return bytes(buffer)


# ----------------------------------------------------------------------
# TIFF
# ----------------------------------------------------------------------

_SHORT = 3
_LONG = 4
_RATIONAL = 5
_TYPE_SIZE = {_SHORT: 2, _LONG: 4, _RATIONAL: 8}


class _TiffIfd:
    """Collects IFD entries and the values that do not fit in 4 bytes.

    A field is stored inline when ``count * typeSize <= 4``; anything longer
    lives in the heap and the entry holds its offset. Getting this wrong for a
    single-strip file is the classic broken-TIFF bug.
    """

    def __init__(self, heap_start: int) -> None:
        self.entries: list[bytes] = []
        self.heap = bytearray()
        self.next_offset = heap_start

    def _value_field(self, type_code: int, values: Sequence[int]) -> bytes:
        packed = _pack_values(type_code, values)
        if _TYPE_SIZE[type_code] * len(values) <= 4:
            return packed.ljust(4, b"\x00")
        offset = self.next_offset
        self.heap += packed
        self.next_offset += len(packed)
        return struct.pack("<I", offset)

    def add(self, tag: int, type_code: int, values: Sequence[int]) -> None:
        field = self._value_field(type_code, list(values))
        self.entries.append(struct.pack("<HHI", tag, type_code, len(values)) + field)

    def pack(self) -> bytes:
        body = b"".join(self.entries)
        return struct.pack("<H", len(self.entries)) + body + struct.pack("<I", 0)


def _pack_values(type_code: int, values: Sequence[int]) -> bytes:
    if type_code == _SHORT:
        return struct.pack(f"<{len(values)}H", *values)
    if type_code == _LONG:
        return struct.pack(f"<{len(values)}I", *values)
    if type_code == _RATIONAL:
        return b"".join(struct.pack("<II", value, 1) for value in values)
    raise PackerError(f"Unsupported TIFF field type: {type_code}")


def write_flat_tiff(
    manifest: dict[str, Any],
    storage_root: StorageRoot | str | Path,
    out_path: Path | str,
    *,
    strip_rows: int = 256,
    compression_level: int = 6,
    overwrite: bool = False,
) -> Path:
    """Baseline little-endian TIFF, deflate strips, ResolutionUnit inch + DPI."""
    root = _as_root(storage_root)
    spec = SheetSpec.from_manifest(manifest)
    renderer = renderer_for(spec, root)
    destination = root.guard_output(out_path, overwrite=overwrite)
    width, height = spec.width_px, spec.height_px
    rows_per_strip = max(1, strip_rows)

    offsets: list[int] = []
    byte_counts: list[int] = []
    with atomic_write_binary(destination) as stream:
        stream.write(struct.pack("<2sHI", b"II", 42, 0))
        for _, _, band in renderer.iter_strips(rows_per_strip):
            offsets.append(stream.tell())
            compressor = zlib.compressobj(compression_level, zlib.DEFLATED, zlib.MAX_WBITS)
            payload = compressor.compress(band.tobytes()) + compressor.flush()
            byte_counts.append(len(payload))
            stream.write(payload)

        ifd = _TiffIfd(stream.tell())
        ifd.add(256, _LONG, [width])
        ifd.add(257, _LONG, [height])
        ifd.add(258, _SHORT, [8, 8, 8, 8])
        ifd.add(259, _SHORT, [8])  # deflate, zlib-wrapped (Adobe TIFF 6.0 supplement)
        ifd.add(262, _SHORT, [2])  # RGB; the fourth sample is unassociated alpha
        ifd.add(273, _LONG, offsets)
        ifd.add(277, _SHORT, [4])
        ifd.add(278, _SHORT, [rows_per_strip])
        ifd.add(279, _LONG, byte_counts)
        ifd.add(282, _RATIONAL, [spec.dpi])
        ifd.add(283, _RATIONAL, [spec.dpi])
        ifd.add(284, _SHORT, [1])
        ifd.add(296, _SHORT, [2])  # inch
        ifd.add(338, _SHORT, [2])  # unassociated alpha
        payload = bytes(ifd.heap)
        stream.write(payload)
        ifd_offset = stream.tell()
        stream.write(ifd.pack())
        stream.seek(0)
        stream.write(struct.pack("<2sHI", b"II", 42, ifd_offset))
    return destination


# ----------------------------------------------------------------------
# psd-bundle
# ----------------------------------------------------------------------


def write_psd_bundle(
    manifest: dict[str, Any],
    storage_root: StorageRoot | str | Path,
    out_dir: Path | str,
    *,
    strip_rows: int = 512,
    overwrite: bool = False,
) -> dict[str, Path]:
    """Flat PNG + manifest copy + ExtendScript rebuild (ADR 0003's layered path)."""
    root = _as_root(storage_root)
    spec = SheetSpec.from_manifest(manifest)
    directory = Path(out_dir).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)

    png_path = write_flat_png(
        manifest, root, directory / "sheet.png", strip_rows=strip_rows, overwrite=overwrite
    )
    manifest_path = root.write_json(directory / "placements.json", manifest, overwrite=overwrite)
    script_path = root.write_text(
        directory / "rebuild.jsx", build_rebuild_script(spec), overwrite=overwrite
    )
    return {
        "flatPng": png_path,
        "manifest": manifest_path,
        "script": script_path,
    }


def build_rebuild_script(spec: SheetSpec) -> str:
    """Photoshop ExtendScript that rebuilds the sheet as one layer per design.

    Rotations are negated because Photoshop angles are counter-clockwise while
    ``rotationDeg`` is clockwise in the sheet's top-left coordinate system.
    """
    placements = [
        {
            "file": entry.get("displayName") or entry["designId"],
            "path": entry["filePath"],
            "x": placement.x_px,
            "y": placement.y_px,
            "rotation": placement.rotation_deg,
        }
        for entry, placement in zip(
            spec.manifest["placements"], spec.placements, strict=True
        )
    ]
    payload = json.dumps(placements, indent=2)
    return f"""// PrintSheet Workbench - sheet rebuild
// Generated by printsheet-packer. Integrity report {spec.report_id}
// Sheet {spec.width_px} x {spec.height_px} px at {spec.dpi} DPI.
//
// Set SOURCE_ROOT to the folder that storage paths are relative to, then run
// this from Photoshop (File > Scripts > Browse). It recreates one layer per
// approved design at the recorded pixel position and 90-degree rotation.
// The flat sheet.png in this bundle is the print-ready reference.

var SOURCE_ROOT = "./storage/";
var MANIFEST = {payload};

app.preferences.rulerUnits = Units.PIXELS;
app.displayDialogs = DialogModes.NO;

var sheetDoc = app.documents.add(
    {spec.width_px},
    {spec.height_px},
    {spec.dpi},
    "PrintSheet sheet",
    NewDocumentMode.RGB,
    DocumentFill.TRANSPARENT
);

for (var i = 0; i < MANIFEST.length; i++) {{
    var item = MANIFEST[i];
    var sourceFile = File(SOURCE_ROOT + "/" + item.path);
    if (!sourceFile.exists) {{
        throw new Error("Missing approved version file: " + sourceFile.fsName);
    }}
    var sourceDoc = app.open(sourceFile);
    sourceDoc.selection.selectAll();
    sourceDoc.selection.copy();
    sourceDoc.close(SaveOptions.DONOTSAVECHANGES);

    sheetDoc.activeLayer = sheetDoc.layers[0];
    sheetDoc.paste();
    var layer = sheetDoc.activeLayer;
    layer.name = String(item.file);

    if (item.rotation !== 0) {{
        layer.rotate(-item.rotation, AnchorPosition.TOPLEFT);
    }}

    var bounds = layer.bounds;
    layer.translate(item.x - bounds[0], item.y - bounds[1], AnchorPosition.TOPLEFT);
}}

alert("Rebuilt " + MANIFEST.length + " layers on a {spec.width_px} x {spec.height_px} px sheet.");
"""


# ----------------------------------------------------------------------
# dispatch
# ----------------------------------------------------------------------


def resolve_format(name: str) -> str:
    if name in REFUSED_FORMATS:
        raise ExportFormatUnavailableError(
            f"{name} is not available: psd-tools cannot write or read layers above the PSD "
            "30,000 px limit, the workaround depends on private state and leaves a stale "
            "composite, and no Photoshop smoke test exists (ADR 0003). Use psd-bundle, which "
            "ships a flat file plus the manifest and a .jsx rebuild script.",
            format=name,
            available=list(AVAILABLE_FORMATS),
        )
    if name not in AVAILABLE_FORMATS:
        raise ExportFormatUnavailableError(
            f"Unknown export format: {name}",
            format=name,
            available=list(ALL_FORMATS),
        )
    return name


def export_artifact(
    name: str,
    manifest: dict[str, Any],
    storage_root: StorageRoot | str | Path,
    out_path: Path | str,
    *,
    strip_rows: int | None = None,
    overwrite: bool = False,
) -> Path | dict[str, Path]:
    """Write one export artifact; partial files are never published."""
    resolve_format(name)
    rows = strip_rows
    if name == FLAT_PNG:
        return write_flat_png(
            manifest, storage_root, out_path, strip_rows=rows or 512, overwrite=overwrite
        )
    if name == FLAT_TIFF:
        return write_flat_tiff(
            manifest, storage_root, out_path, strip_rows=rows or 256, overwrite=overwrite
        )
    return write_psd_bundle(
        manifest, storage_root, out_path, strip_rows=rows or 512, overwrite=overwrite
    )


def _as_root(storage_root: StorageRoot | str | Path) -> StorageRoot:
    return storage_root if isinstance(storage_root, StorageRoot) else StorageRoot(storage_root)


def hash_sources(
    root: StorageRoot, designs: Iterable[Any]
) -> dict[str, tuple[str, str]]:
    """Relative path and sha256 of every approved source file."""
    out: dict[str, tuple[str, str]] = {}
    for design in designs:
        path = root.open_read(design.file_path)
        out[design.design_id] = (design.file_path, sha256_of(path.read_bytes()))
    return out


def verify_source_hashes(
    manifest: dict[str, Any], root: StorageRoot
) -> list[dict[str, Any]]:
    """Placements whose file changed or disappeared since the sheet was packed."""
    problems: list[dict[str, Any]] = []
    for entry in manifest["placements"]:
        try:
            path = root.open_read(entry["filePath"])
        except MissingSourceError:
            problems.append(
                {"designId": entry["designId"], "reason": "missing", "path": entry["filePath"]}
            )
            continue
        digest = sha256_of(path.read_bytes())
        if digest != entry["sha256"]:
            problems.append(
                {"designId": entry["designId"], "reason": "changed", "path": entry["filePath"]}
            )
    return problems


def source_loader(root: StorageRoot, manifest: dict[str, Any]) -> Callable[[str], np.ndarray]:
    entries = {entry["designId"]: entry for entry in manifest["placements"]}

    def load(design_id: str) -> np.ndarray:
        entry = entries.get(design_id)
        if entry is None:
            raise PackerError(f"Design {design_id} is not in this manifest")
        return load_rgba(root.open_read(entry["filePath"]))

    return load


__all__ = [
    "ALL_FORMATS",
    "AVAILABLE_FORMATS",
    "FLAT_PNG",
    "FLAT_TIFF",
    "MANIFEST_KIND",
    "PSD_BUNDLE",
    "REFUSED_FORMATS",
    "SheetSpec",
    "build_manifest",
    "build_rebuild_script",
    "export_artifact",
    "hash_sources",
    "manifest_schema_path",
    "read_manifest",
    "renderer_for",
    "require_manifest_valid",
    "resolve_format",
    "sha256_of",
    "source_loader",
    "verify_source_hashes",
    "write_flat_png",
    "write_flat_tiff",
    "write_manifest",
    "write_psd_bundle",
]
