using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>A packing result for one batch revision. Immutable geometry with mutable review state.</summary>
public sealed class Sheet
{
    private readonly List<Placement> _placements = [];

    private Sheet()
    {
        IntegrityReportJson = null;
        PreviewPath = string.Empty;
        ManifestPath = string.Empty;
    }

    private Sheet(
        Guid id,
        Guid batchId,
        int revision,
        decimal widthCm,
        decimal heightCm,
        int widthPx,
        int heightPx,
        int dpi,
        IReadOnlyList<Placement> placements,
        Money estimatedCost,
        string previewPath,
        string manifestPath,
        DateTimeOffset createdAt)
    {
        Id = id;
        BatchId = batchId;
        Revision = revision;
        State = SheetState.Unchecked;
        Stale = false;
        WidthCm = widthCm;
        HeightCm = heightCm;
        WidthPx = widthPx;
        HeightPx = heightPx;
        Dpi = dpi;
        _placements.AddRange(placements);
        EstimatedCost = estimatedCost;
        PreviewPath = previewPath;
        ManifestPath = manifestPath;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }

    public Guid BatchId { get; private set; }

    public int Revision { get; private set; }

    public SheetState State { get; private set; }

    public bool Stale { get; private set; }

    public decimal WidthCm { get; private set; }

    public decimal HeightCm { get; private set; }

    public int WidthPx { get; private set; }

    public int HeightPx { get; private set; }

    public int Dpi { get; private set; }

    public IReadOnlyList<Placement> Placements => _placements;

    public string? IntegrityReportJson { get; private set; }

    public Money EstimatedCost { get; private set; } = null!;

    /// <summary>Relative storage path of the low-resolution review preview.</summary>
    public string PreviewPath { get; private set; }

    /// <summary>Relative storage path of the placements manifest used by exporters.</summary>
    public string ManifestPath { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    public bool IntegrityPassed => State == SheetState.Valid && IntegrityReportJson is not null;

    public static Result<Sheet> CreatePacked(
        Guid id,
        Guid batchId,
        int revision,
        decimal widthCm,
        decimal heightCm,
        int widthPx,
        int heightPx,
        int dpi,
        IReadOnlyList<Placement> placements,
        Money estimatedCost,
        string previewPath,
        string manifestPath,
        DateTimeOffset createdAt)
    {
        if (id == Guid.Empty || batchId == Guid.Empty)
        {
            return Result<Sheet>.Failure(ErrorCodes.InvalidRequest, "Sheet ids are required.");
        }

        if (revision < 1)
        {
            return Result<Sheet>.Failure(ErrorCodes.InvalidRequest, "Sheet revision must be at least 1.");
        }

        if (widthCm <= 0 || heightCm <= 0 || widthPx < 1 || heightPx < 1 || dpi is < 72 or > 1200)
        {
            return Result<Sheet>.Failure(ErrorCodes.InvalidRequest, "Sheet geometry is invalid.");
        }

        foreach (var placement in placements)
        {
            if (!placement.IsInside(widthCm, heightCm))
            {
                return Result<Sheet>.Failure(
                    ErrorCodes.InvalidRequest,
                    $"Placement for design {placement.DesignId} is outside the sheet.");
            }
        }

        if (string.IsNullOrWhiteSpace(previewPath) || string.IsNullOrWhiteSpace(manifestPath))
        {
            return Result<Sheet>.Failure(
                ErrorCodes.InvalidRequest,
                "Sheet preview and manifest paths are required.");
        }

        return Result<Sheet>.Success(new Sheet(
            id,
            batchId,
            revision,
            widthCm,
            heightCm,
            widthPx,
            heightPx,
            dpi,
            placements,
            estimatedCost,
            previewPath,
            manifestPath,
            createdAt));
    }

    /// <summary>
    /// Applies a report for this exact revision. The caller must have verified
    /// the report was produced for the current revision and geometry.
    /// </summary>
    public Result ApplyIntegrityReport(bool passed, string reportJson, DateTimeOffset at)
    {
        if (Stale)
        {
            return Result.Failure(
                ErrorCodes.SheetStale,
                "The sheet changed after the integrity check started; the report was discarded.");
        }

        if (string.IsNullOrWhiteSpace(reportJson))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "An integrity report is required.");
        }

        IntegrityReportJson = reportJson;
        State = passed ? SheetState.Valid : SheetState.Invalid;
        UpdatedAt = at;
        return Result.Success();
    }

    public Result StorePackingReport(string reportJson, DateTimeOffset at)
    {
        if (Stale)
        {
            return Result.Failure(
                ErrorCodes.SheetStale,
                "The sheet changed while packing; the report was discarded.");
        }

        if (string.IsNullOrWhiteSpace(reportJson))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "A packing report is required.");
        }

        IntegrityReportJson = reportJson;
        State = SheetState.Unchecked;
        UpdatedAt = at;
        return Result.Success();
    }

    /// <summary>Replaces all placements, bumps the revision and clears the report.</summary>
    public Result ApplyManualPlacements(IReadOnlyList<Placement> placements, DateTimeOffset at)
    {
        if (placements.Count == 0)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "At least one placement is required.");
        }

        foreach (var placement in placements)
        {
            if (!placement.IsInside(WidthCm, HeightCm))
            {
                return Result.Failure(
                    ErrorCodes.InvalidRequest,
                    $"Placement for design {placement.DesignId} is outside the sheet.");
            }
        }

        _placements.Clear();
        _placements.AddRange(placements);
        Revision++;
        IntegrityReportJson = null;
        State = SheetState.Unchecked;
        Stale = false;
        UpdatedAt = at;
        return Result.Success();
    }

    public void MarkStale(DateTimeOffset at)
    {
        if (Stale)
        {
            return;
        }

        Stale = true;
        UpdatedAt = at;
    }
}
