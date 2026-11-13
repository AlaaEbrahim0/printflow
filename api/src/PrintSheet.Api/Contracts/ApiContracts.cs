using System.Text.Json;

namespace PrintSheet.Api.Contracts;

// Response shapes mirror the frozen OpenAPI 3.0.3 contract exactly. Enum-like
// values are strings on the wire; domain enums are converted at the boundary.

public sealed record GarmentColorDto(string Kind, string? Hex);

public sealed record MoneyDto(decimal Amount, string Currency);

public sealed record BatchSummaryDto(
    Guid Id,
    string Name,
    string Status,
    decimal RollWidthCm,
    decimal MarginMm,
    decimal EdgeMarginMm,
    int WorkingDpi,
    int DesignCount,
    int ReadyCount,
    int ExcludedCount,
    decimal? SheetHeightCm,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record BatchDetailDto(
    Guid Id,
    string Name,
    string Status,
    decimal RollWidthCm,
    decimal MarginMm,
    decimal EdgeMarginMm,
    int WorkingDpi,
    int DesignCount,
    int ReadyCount,
    int ExcludedCount,
    decimal? SheetHeightCm,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    IReadOnlyList<DesignSummaryDto> Designs,
    SheetDto? Sheet);

public sealed record BatchListDto(IReadOnlyList<BatchSummaryDto> Items, int Total);

public sealed record VersionSummaryDto(
    Guid Id,
    Guid DesignId,
    Guid? ParentId,
    string StepType,
    string Status,
    int WidthPx,
    int HeightPx,
    bool HasAlpha,
    DateTimeOffset CreatedAt,
    string FileUrl);

public sealed record VersionArtifactsDto(string? MaskUrl, string? SvgUrl);

public sealed record DesignVersionDto(
    Guid Id,
    Guid DesignId,
    Guid? ParentId,
    string StepType,
    string Status,
    int WidthPx,
    int HeightPx,
    bool HasAlpha,
    DateTimeOffset CreatedAt,
    string FileUrl,
    JsonElement Parameters,
    VersionArtifactsDto? Artifacts,
    DateTimeOffset? ApprovedAt,
    DateTimeOffset? RejectedAt);

public sealed record DesignSummaryDto(
    Guid Id,
    Guid BatchId,
    string Name,
    string Status,
    GarmentColorDto GarmentColor,
    bool AllowRotation,
    Guid OriginalVersionId,
    Guid CurrentVersionId,
    decimal? TargetWidthCm,
    decimal? TargetHeightCm,
    decimal? EffectiveDpi,
    int VersionCount,
    VersionSummaryDto? CurrentVersion,
    VersionSummaryDto? PendingVersion,
    string? Notes,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record DesignDetailDto(
    Guid Id,
    Guid BatchId,
    string Name,
    string Status,
    GarmentColorDto GarmentColor,
    bool AllowRotation,
    Guid OriginalVersionId,
    Guid CurrentVersionId,
    decimal? TargetWidthCm,
    decimal? TargetHeightCm,
    decimal? EffectiveDpi,
    int VersionCount,
    VersionSummaryDto? CurrentVersion,
    VersionSummaryDto? PendingVersion,
    string? Notes,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    IReadOnlyList<DesignVersionDto> Versions);

public sealed record RejectVersionResponseDto(
    DesignDetailDto Design,
    IReadOnlyList<string> NextActions);

public sealed record PlacementDto(
    Guid DesignId,
    Guid VersionId,
    string? DesignName,
    decimal XCm,
    decimal YCm,
    decimal WidthCm,
    decimal HeightCm,
    int WidthPx,
    int HeightPx,
    int RotationDeg);

public sealed record SheetDto(
    Guid Id,
    Guid BatchId,
    int Revision,
    string State,
    decimal WidthCm,
    decimal HeightCm,
    int WidthPx,
    int HeightPx,
    int Dpi,
    IReadOnlyList<PlacementDto> Placements,
    JsonElement? IntegrityReport,
    bool Stale,
    MoneyDto EstimatedCost,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record ExportArtifactDto(
    string Name,
    string ContentType,
    long SizeBytes,
    string DownloadUrl);

public sealed record ExportDto(
    Guid Id,
    Guid BatchId,
    int SheetRevision,
    string Format,
    string Status,
    int Dpi,
    IReadOnlyList<ExportArtifactDto> Artifacts,
    JsonElement? IntegrityReport,
    string? BlockedReason,
    JsonElement? Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt);

public sealed record ExportListDto(IReadOnlyList<ExportDto> Items);

public sealed record JobAcceptedDto(Guid JobId, string Status, string PollUrl);

public sealed record JobDto(
    Guid Id,
    Guid BatchId,
    Guid? DesignId,
    string Type,
    string Status,
    JsonElement Parameters,
    JsonElement? Result,
    JobErrorDto? Error,
    int Attempts,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    int? DurationMs);

public sealed record JobListDto(IReadOnlyList<JobDto> Items, int Total);

public sealed record WorkerJobDto(
    string SchemaVersion,
    Guid JobId,
    string Type,
    Guid BatchId,
    Guid DesignId,
    string InputPath,
    string? OutputPath,
    IReadOnlyDictionary<string, string> InputArtifacts,
    IReadOnlyDictionary<string, string> OutputArtifacts,
    JsonElement Parameters,
    JsonElement Context);

public sealed record JobAssignmentDto(
    string LeaseToken,
    DateTimeOffset LeaseExpiresAt,
    WorkerJobDto Job);

public sealed record ClassifierSuggestionsDto(
    Guid DesignId,
    string Status,
    DateTimeOffset? AnalyzedAt,
    JsonElement? Source,
    JsonElement? Features,
    JsonElement? Suggestions);

public sealed record ProblemDetailsDto(
    string Title,
    int Status,
    string? Detail,
    string? Instance,
    string? Code,
    IReadOnlyDictionary<string, object?>? Errors);

// ----- Requests -----------------------------------------------------------

public sealed record CreateBatchRequest(
    string Name,
    decimal? RollWidthCm,
    decimal? MarginMm,
    decimal? EdgeMarginMm,
    int? WorkingDpi);

public sealed record UpdateBatchRequest(
    string? Name,
    decimal? RollWidthCm,
    decimal? MarginMm,
    decimal? EdgeMarginMm);

public sealed record GarmentColorRequest(string? Kind, string? Hex);

public sealed record CropRectRequest(int X, int Y, int Width, int Height);

public sealed record BackgroundSampleRequest(string? Kind, string? Hex, int? AlphaThreshold);

public sealed record TrimStepRequest(
    string Mode,
    int? PaddingPx,
    int? Tolerance,
    CropRectRequest? CropRect,
    BackgroundSampleRequest? BackgroundSample);

public sealed record CropStepRequest(CropRectRequest Rect);

public sealed record UpscaleStepRequest(string Model, int Scale, int? TileSize, bool? Gpu);

public sealed record ResizeStepRequest(
    decimal TargetWidthCm,
    decimal TargetHeightCm,
    string? FitMode,
    int? Dpi);

public sealed record BackgroundRemovalStepRequest(
    string Mode,
    string? KeyColor,
    int? Tolerance,
    decimal? EdgeSoftness,
    string? AiModel,
    IReadOnlyList<BrushOpRequest>? BrushOps,
    decimal? MaskGrowPx,
    LevelsAdjustmentRequest? MaskLevels,
    LevelsAdjustmentRequest? ImageLevels,
    decimal? MaskMinAreaPx);

/// <summary>Photoshop-style levels for the mask ramp or the cut-out colours.</summary>
public sealed record LevelsAdjustmentRequest(
    int? BlackPoint,
    int? WhitePoint,
    decimal? Gamma,
    int? OutputBlack,
    int? OutputWhite);

/// <summary>One erase/restore stroke. Points are source pixel [x, y] pairs.</summary>
public sealed record BrushOpRequest(
    string Tool,
    int RadiusPx,
    IReadOnlyList<int[]>? Points);

public sealed record RejectVersionRequest(string? Reason);

public sealed record RevertVersionRequest(Guid VersionId);

public sealed record PackSheetRequest(
    IReadOnlyList<Guid>? DesignIds,
    int? Seed,
    int? RandomizedOrderings,
    int? TimeBudgetMs,
    bool? NoInterlocking,
    int? AlphaThreshold,
    decimal? CellMm);

public sealed record ManualPlacementRequest(
    Guid DesignId,
    Guid VersionId,
    decimal XCm,
    decimal YCm,
    int RotationDeg);

public sealed record PlacementsUpdateRequest(
    int Revision,
    IReadOnlyList<ManualPlacementRequest> Placements);

public sealed record ExportRequest(string Format, bool? IncludePreview);

public sealed record ClaimJobsRequest(
    string WorkerId,
    IReadOnlyList<string> Capabilities,
    int? LeaseSeconds);

public sealed record HeartbeatRequest(string LeaseToken, int? ExtendSeconds);

public sealed record WorkerCompletionRequest(string LeaseToken, JsonElement Result);

public sealed record JobErrorDto(string Code, string Message, bool Retryable, JsonElement? Details);

public sealed record JobFailureRequest(string LeaseToken, JobErrorDto Error);

public sealed record PackerSettingsDto(
    int AlphaThreshold,
    decimal CellMm,
    int RandomizedOrderings,
    int TimeBudgetMs);

public sealed record AppSettingsDto(
    int WorkingDpi,
    decimal DefaultRollWidthCm,
    decimal DefaultMarginMm,
    decimal DefaultEdgeMarginMm,
    int DpiWarnBelow,
    int DpiStrongWarnBelow,
    decimal PricePerCm,
    string Currency,
    PackerSettingsDto Packer);
