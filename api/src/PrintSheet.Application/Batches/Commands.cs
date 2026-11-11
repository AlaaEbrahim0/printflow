using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Application.Batches;

public sealed record CreateBatchCommand(
    string Name,
    decimal? RollWidthCm,
    decimal? MarginMm,
    decimal? EdgeMarginMm,
    int? WorkingDpi);

public sealed record UpdateBatchCommand(
    string? Name,
    decimal? RollWidthCm,
    decimal? MarginMm,
    decimal? EdgeMarginMm);

public sealed record UpdateDesignCommand(
    Optional<string> Name,
    Optional<GarmentColor> GarmentColor,
    Optional<bool> AllowRotation,
    Optional<decimal?> TargetWidthCm,
    Optional<decimal?> TargetHeightCm,
    Optional<string?> Notes);

public sealed record UploadDesignCommand(
    Stream File,
    long Length,
    string FileName,
    string? Name,
    GarmentColorKind GarmentColorKind,
    string? GarmentColorHex,
    decimal? TargetWidthCm,
    decimal? TargetHeightCm,
    bool ReadyToPack = false);

public sealed record TrimStepCommand(
    string Mode,
    int? PaddingPx,
    int? Tolerance,
    CropRect? CropRect,
    BackgroundSampleCommand? BackgroundSample);

public sealed record BackgroundSampleCommand(
    string Kind,
    string? Hex,
    int? AlphaThreshold);

public sealed record CropStepCommand(CropRect Rect);

public sealed record UpscaleStepCommand(
    string Model,
    int Scale,
    int? TileSize,
    bool Gpu);

public sealed record ResizeStepCommand(
    decimal TargetWidthCm,
    decimal TargetHeightCm,
    string? FitMode,
    int? Dpi);

/// <summary>
/// A browser-rasterised manual cleanup (crop, levels, colour, cut-out) uploaded
/// as a finished PNG. The operator is the processor, so there is no job; the
/// bytes still become a new proposed version that must be approved.
/// </summary>
public sealed record ManualEditCommand(
    Stream File,
    long Length,
    string FileName,
    Guid ParentVersionId,
    string? Mode,
    bool? CropApplied,
    ManualCropRect? CropRect,
    IReadOnlyList<BrushOpCommand>? BrushOps,
    LevelsAdjustmentCommand? ImageLevels,
    decimal? HueShift,
    decimal? Saturation,
    decimal? Lightness,
    string? Notes,
    string EditorProfile);

/// <summary>The crop taken from the parent, in parent pixel coordinates.</summary>
public sealed record ManualCropRect(int X, int Y, int Width, int Height);

/// <summary>
/// A background-removal proposal. The mask is the reviewable artifact: the worker
/// writes an 8-bit grayscale mask and the cut-out image, never touching the source.
/// </summary>
public sealed record BackgroundRemovalStepCommand(
    string Mode,
    string? KeyColor,
    int? Tolerance,
    decimal? EdgeSoftness,
    string? AiModel,
    IReadOnlyList<BrushOpCommand>? BrushOps,
    decimal? MaskGrowPx = null,
    LevelsAdjustmentCommand? MaskLevels = null,
    LevelsAdjustmentCommand? ImageLevels = null);

/// <summary>
/// Photoshop-style levels. The same object shapes the mask alpha ramp and the
/// cut-out colours, but the two stay independent: tone and selection are judged
/// separately during review.
/// </summary>
public sealed record LevelsAdjustmentCommand(
    int? BlackPoint,
    int? WhitePoint,
    decimal? Gamma,
    int? OutputBlack,
    int? OutputWhite);

/// <summary>
/// One erase/restore stroke. Points are in source pixel coordinates, so a stroke
/// stays valid against the version it was drawn on.
/// </summary>
public sealed record BrushOpCommand(
    string Tool,
    int RadiusPx,
    IReadOnlyList<BrushPointCommand> Points);

public sealed record BrushPointCommand(int X, int Y);

public sealed record PackSheetCommand(
    IReadOnlyList<Guid>? DesignIds,
    int? Seed,
    int? RandomizedOrderings,
    int? TimeBudgetMs,
    bool NoInterlocking,
    int? AlphaThreshold,
    decimal? CellMm);

public sealed record ManualPlacementCommand(
    Guid DesignId,
    Guid VersionId,
    decimal XCm,
    decimal YCm,
    int RotationDeg);

public sealed record CreateExportCommand(ExportFormat Format, bool IncludePreview);
