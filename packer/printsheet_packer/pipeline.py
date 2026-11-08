"""End-to-end library entry points: pack, verify, and response assembly.

The CLI and any embedding caller (the API in a later phase) go through here so
that request validation, packing, integrity, manifest and preview writing can
never be partially re-implemented.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from printsheet_packer.contracts import (
    PACKER_RESPONSE,
    ContractStore,
    PackRequest,
    new_report_id,
    parse_pack_request,
    sheet_geometry,
    utc_timestamp,
)
from printsheet_packer.errors import IntegrityFailedError, PackerError
from printsheet_packer.export import (
    build_manifest,
    hash_sources,
    read_manifest,
    require_manifest_valid,
    sha256_of,
    source_loader,
    verify_source_hashes,
    write_manifest,
)
from printsheet_packer.integrity import (
    ReportContext,
    build_placed_masks,
    build_report,
    dilation_radius_px,
    verify_layout,
)
from printsheet_packer.masks import (
    DesignMask,
    build_design_mask,
    fit_rgba_to_target,
    load_rgba,
    required_margin_px,
)
from printsheet_packer.nesting import Layout, Packer
from printsheet_packer.render import RenderPlacement, SheetRenderer, preview_from_renderer
from printsheet_packer.storage import StorageRoot


@dataclass
class PackOutcome:
    request: PackRequest
    layout: Layout
    report: dict[str, Any]
    manifest: dict[str, Any]
    response: dict[str, Any]
    warnings: list[dict[str, Any]] = field(default_factory=list)
    written: dict[str, Path] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return bool(self.report["passed"])


def load_masks(
    request: PackRequest, root: StorageRoot
) -> tuple[dict[str, DesignMask], dict[str, np.ndarray]]:
    """Decode every approved source once; return masks and the RGBA arrays."""
    masks: dict[str, DesignMask] = {}
    images: dict[str, np.ndarray] = {}
    for design in request.designs:
        payload = root.read_bytes(design.file_path)
        rgba = load_rgba(payload)
        prepared_design, prepared_rgba = fit_rgba_to_target(design, rgba, request.dpi)
        masks[design.design_id] = build_design_mask(
            prepared_design, prepared_rgba, request.alpha_threshold
        )
        images[design.design_id] = prepared_rgba
    return masks, images


def renderer_for_layout(
    layout: Layout, images: dict[str, np.ndarray]
) -> SheetRenderer:
    placements = tuple(
        RenderPlacement(
            design_id=placed.design_id,
            x_px=placed.x_px,
            y_px=placed.y_px,
            width_px=placed.footprint.image_width_px,
            height_px=placed.footprint.image_height_px,
            rotation_deg=placed.rotation_deg,
        )
        for placed in layout.placed
    )

    def load(design_id: str) -> np.ndarray:
        try:
            return images[design_id]
        except KeyError as exc:
            raise PackerError(f"No image data for design {design_id}") from exc

    return SheetRenderer(
        layout.sheet_width_px, layout.sheet_height_px, placements, load
    )


def measure_layout(
    layout: Layout, images: dict[str, np.ndarray]
) -> tuple[Any, SheetRenderer]:
    """Full-resolution measurements for the four blocking checks."""
    request = layout.request
    renderer = renderer_for_layout(layout, images)
    designs = build_placed_masks(
        [_placement_record(placed) for placed in layout.placed],
        renderer_loader(images),
        request.alpha_threshold,
    )
    return (
        verify_layout(
            designs,
            dpi=request.dpi,
            margin_px=layout.margin_px,
            margin_mm=request.margin_mm,
            edge_margin_px=layout.edge_margin_px,
            edge_margin_mm=request.edge_margin_mm,
            dilation_radius_px=dilation_radius_px(layout.margin_px),
            sheet_width_px=layout.sheet_width_px,
            sheet_height_px=layout.sheet_height_px,
            renderer=renderer,
        ),
        renderer,
    )


def renderer_loader(images: dict[str, np.ndarray]):
    """Loader view over already-decoded designs."""

    def load(design_id: str) -> np.ndarray:
        try:
            return images[design_id]
        except KeyError as exc:
            raise PackerError(f"No image data for design {design_id}") from exc

    return load


def _placement_record(placed: Any) -> dict[str, Any]:
    return {
        "designId": placed.design_id,
        "versionId": placed.candidate.design.version_id,
        "displayName": placed.candidate.design.display_name,
        "xPx": placed.x_px,
        "yPx": placed.y_px,
        "rotationDeg": placed.rotation_deg,
    }


def target_size_warnings(
    request: PackRequest, masks: dict[str, DesignMask]
) -> list[dict[str, Any]]:
    """Report source files resampled to an explicitly chosen target box."""
    warnings = []
    for design in request.designs:
        prepared = masks[design.design_id].design
        if prepared.width_px == design.width_px and prepared.height_px == design.height_px:
            continue
        warnings.append(
            {
                "code": "target-resampled",
                "message": (
                    f"{design.label} was Lanczos-resampled into the operator-selected "
                    f"{design.target_width_cm} × {design.target_height_cm} cm target box "
                    "while preserving aspect ratio."
                ),
                "details": {
                    "designId": design.design_id,
                    "sourceWidthPx": design.width_px,
                    "sourceHeightPx": design.height_px,
                    "outputWidthPx": prepared.width_px,
                    "outputHeightPx": prepared.height_px,
                    "targetWidthCm": design.target_width_cm,
                    "targetHeightCm": design.target_height_cm,
                },
            }
        )
    return warnings


def build_response(
    request: PackRequest,
    layout: Layout,
    report: dict[str, Any],
    outputs: dict[str, str],
    warnings: list[dict[str, Any]],
) -> dict[str, Any]:
    response: dict[str, Any] = {
        "schemaVersion": "2.0",
        "requestId": request.request_id,
        "sheet": sheet_geometry(layout.sheet_width_px, layout.sheet_height_px, request.dpi),
        "placements": [placement.to_json(request.dpi) for placement in layout.placements],
        "unplacedDesigns": [item.to_json() for item in layout.unplaced],
        "integrityReport": report,
        "outputs": outputs,
        "stats": {
            "designCount": len(layout.placed),
            "requestedDesignCount": len(request.designs),
            "unplacedDesignCount": len(layout.unplaced),
            "durationMs": layout.duration_ms,
            "orderingsTried": layout.orderings_tried,
            "seed": request.seed,
            "occupancyRatio": round(layout.occupancy_ratio, 6),
        },
    }
    if warnings:
        response["warnings"] = warnings
    return response


def run_pack(
    request: PackRequest,
    storage_root: StorageRoot | str | Path,
    *,
    write_outputs: bool = True,
    preview: bool = True,
    preview_width_px: int = 900,
    report_id: str | None = None,
    overwrite: bool = False,
) -> PackOutcome:
    """Validate, nest, verify, and (optionally) write the pack artifacts."""
    root = storage_root if isinstance(storage_root, StorageRoot) else StorageRoot(storage_root)
    masks, images = load_masks(request, root)
    layout = Packer(request, masks).run()
    measured, renderer = measure_layout(layout, images)
    context = ReportContext(
        dpi=request.dpi,
        sheet_width_px=layout.sheet_width_px,
        sheet_height_px=layout.sheet_height_px,
        design_count=len(layout.placed),
        duration_ms=layout.duration_ms,
        occupancy_ratio=layout.occupancy_ratio,
        orderings_tried=layout.orderings_tried,
        requested_design_count=len(request.designs),
        unplaced_designs=tuple(item.to_json() for item in layout.unplaced),
    )
    report = build_report(measured, context, report_id=report_id or new_report_id())

    warnings = target_size_warnings(request, masks)
    if measured.clipped_placements:
        warnings.append(
            {
                "code": "footprint-clipped",
                "message": (
                    f"{measured.clipped_placements} placement(s) have transparent padding "
                    "outside the sheet; visible pixels are unaffected"
                ),
                "details": {"count": measured.clipped_placements},
            }
        )

    outputs: dict[str, str] = {"manifestPath": request.output.manifest_path}
    if request.output.preview_path and preview:
        outputs["previewPath"] = request.output.preview_path

    written: dict[str, Path] = {}
    manifest: dict[str, Any] | None = None
    if write_outputs:
        manifest = build_manifest(request, layout, report, hash_sources(root, request.designs))
        if "previewPath" in outputs:
            manifest["outputs"] = {"previewPath": outputs["previewPath"]}
        written["manifest"] = write_manifest(
            root, request.output.manifest_path, manifest, overwrite=overwrite
        )
        if "previewPath" in outputs:
            preview_image = preview_from_renderer(renderer, target_width_px=preview_width_px)
            memory = io.BytesIO()
            preview_image.save(memory, format="PNG")
            written["preview"] = root.write_bytes(
                root.resolve(outputs["previewPath"], field="output.previewPath"),
                memory.getvalue(),
                overwrite=overwrite,
            )

    response = build_response(request, layout, report, outputs, warnings)
    ContractStore().require_valid(PACKER_RESPONSE, response)
    outcome = PackOutcome(
        request=request,
        layout=layout,
        report=report,
        manifest=manifest or {},
        response=response,
        warnings=warnings,
        written=written,
    )
    return outcome


def pack_from_document(
    document: dict[str, Any], storage_root: StorageRoot | str | Path, **kwargs: Any
) -> PackOutcome:
    return run_pack(parse_pack_request(document), storage_root, **kwargs)


def require_passed(outcome: PackOutcome) -> PackOutcome:
    if not outcome.passed:
        raise IntegrityFailedError(
            "Integrity checks did not pass; the sheet must not be exported", outcome.report
        )
    return outcome


def _not_runnable_report(manifest: dict[str, Any]) -> dict[str, Any]:
    """A report that says the checks could not be run, so export stays blocked."""
    from printsheet_packer.integrity import CHECK_ORDER

    sheet = manifest["sheet"]
    checks = [
        {
            "id": check_id,
            "blocking": True,
            "status": "skipped",
            "message": "The approved source files no longer match the packed sheet.",
            "details": {},
        }
        for check_id in CHECK_ORDER
    ]
    return {
        "schemaVersion": "2.0",
        "reportId": new_report_id(),
        "generatedAt": utc_timestamp(),
        "passed": False,
        "sheet": sheet_geometry(sheet["widthPx"], sheet["heightPx"], sheet["dpi"]),
        "checks": checks,
        "failures": [
            {"checkId": check_id, "message": "Source files changed since the sheet was packed."}
            for check_id in CHECK_ORDER
        ],
        "metrics": {
            "designCount": len(manifest["placements"]),
            "requestedDesignCount": len(
                manifest.get("requestedDesigns", manifest["placements"])
            ),
            "unplacedDesignCount": len(manifest.get("unplacedDesigns", [])),
            "durationMs": 0,
        },
    }


@dataclass
class VerifyOutcome:
    report: dict[str, Any]
    source_problems: list[dict[str, Any]]
    manifest: dict[str, Any]

    @property
    def passed(self) -> bool:
        return bool(self.report["passed"]) and not self.source_problems


def verify_manifest(
    manifest: dict[str, Any] | Path | str,
    storage_root: StorageRoot | str | Path,
    *,
    report_id: str | None = None,
) -> VerifyOutcome:
    """Re-run the blocking checks against a manifest's placements."""
    root = storage_root if isinstance(storage_root, StorageRoot) else StorageRoot(storage_root)
    if isinstance(manifest, (str, Path)):
        document = read_manifest(manifest)
    else:
        require_manifest_valid(manifest)
        document = manifest

    # Hashes first: a replaced or undecodable approved file is answered with
    # "source-changed", not with a Pillow error from half-way through the render.
    problems = verify_source_hashes(document, root)
    if problems:
        return VerifyOutcome(
            report=_not_runnable_report(document), source_problems=problems, manifest=document
        )

    sheet = document["sheet"]
    parameters = document["parameters"]
    loader = source_loader(root, document)
    designs = build_placed_masks(
        document["placements"], loader, parameters["alphaThreshold"]
    )
    placements = tuple(
        RenderPlacement(
            design_id=entry["designId"],
            x_px=entry["xPx"],
            y_px=entry["yPx"],
            width_px=entry["widthPx"],
            height_px=entry["heightPx"],
            rotation_deg=entry["rotationDeg"],
        )
        for entry in document["placements"]
    )
    renderer = SheetRenderer(sheet["widthPx"], sheet["heightPx"], placements, loader)
    margin_px = required_margin_px(parameters["marginMm"], sheet["dpi"])
    measured = verify_layout(
        designs,
        dpi=sheet["dpi"],
        margin_px=margin_px,
        margin_mm=parameters["marginMm"],
        edge_margin_px=required_margin_px(parameters["edgeMarginMm"], sheet["dpi"]),
        edge_margin_mm=parameters["edgeMarginMm"],
        dilation_radius_px=dilation_radius_px(margin_px),
        sheet_width_px=sheet["widthPx"],
        sheet_height_px=sheet["heightPx"],
        renderer=renderer,
    )
    visible = sum(design.visible_pixels for design in designs)
    context = ReportContext(
        dpi=sheet["dpi"],
        sheet_width_px=sheet["widthPx"],
        sheet_height_px=sheet["heightPx"],
        design_count=len(designs),
        duration_ms=0,
        occupancy_ratio=visible / (sheet["widthPx"] * sheet["heightPx"]),
        orderings_tried=parameters["orderingsTried"],
        requested_design_count=len(
            document.get("requestedDesigns", document["placements"])
        ),
        unplaced_designs=tuple(document.get("unplacedDesigns", [])),
    )
    report = build_report(measured, context, report_id=report_id or new_report_id())
    return VerifyOutcome(report=report, source_problems=[], manifest=document)


__all__ = [
    "PackOutcome",
    "VerifyOutcome",
    "build_response",
    "load_masks",
    "pack_from_document",
    "renderer_for_layout",
    "require_passed",
    "run_pack",
    "sha256_of",
    "target_size_warnings",
    "verify_manifest",
]
