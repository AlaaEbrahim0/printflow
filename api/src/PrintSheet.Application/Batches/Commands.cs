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
    decimal? TargetHeightCm);

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
