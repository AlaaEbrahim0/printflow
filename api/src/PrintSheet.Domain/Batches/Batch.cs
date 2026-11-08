using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// Aggregate root for one customer order. Owns designs, sheets, exports and
/// audit entries; jobs are a separate persistence concern.
/// </summary>
public sealed class Batch
{
    public const int MaxNameLength = 200;

    private readonly List<Design> _designs = [];
    private readonly List<Sheet> _sheets = [];
    private readonly List<ExportRecord> _exports = [];
    private readonly List<AuditEntry> _auditEntries = [];

    private Batch()
    {
        Name = string.Empty;
        Status = BatchStatus.Collecting;
        Geometry = BatchGeometry.Default;
    }

    private Batch(Guid id, string name, BatchGeometry geometry, DateTimeOffset createdAt)
    {
        Id = id;
        Name = name;
        Status = BatchStatus.Collecting;
        Geometry = geometry;
        RowVersion = 1;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }

    public string Name { get; private set; }

    public BatchStatus Status { get; private set; }

    public BatchGeometry Geometry { get; private set; }

    /// <summary>Optimistic concurrency token, incremented on every mutation.</summary>
    public long RowVersion { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    public IReadOnlyList<Design> Designs => _designs;

    public IReadOnlyList<Sheet> Sheets => _sheets;

    public IReadOnlyList<ExportRecord> Exports => _exports;

    public IReadOnlyList<AuditEntry> AuditEntries => _auditEntries;

    public Sheet? CurrentSheet => _sheets
        .OrderByDescending(sheet => sheet.Revision)
        .FirstOrDefault();

    public int CurrentRevision => CurrentSheet?.Revision ?? 0;

    public int DesignCount => _designs.Count;

    public int ReadyCount => _designs.Count(design => design.Status == DesignStatus.Ready);

    public int ExcludedCount => _designs.Count(design => design.Status == DesignStatus.Excluded);

    public IReadOnlyList<Design> IncludedDesigns => _designs
        .Where(design => design.Status != DesignStatus.Excluded)
        .ToList();

    public static Result<Batch> Create(
        Guid id,
        string name,
        BatchGeometry geometry,
        DateTimeOffset createdAt)
    {
        if (id == Guid.Empty)
        {
            return Result<Batch>.Failure(ErrorCodes.InvalidRequest, "Batch id is required.");
        }

        var nameError = ValidateName(name);
        if (nameError is not null)
        {
            return Result<Batch>.Failure(nameError);
        }

        var batch = new Batch(id, name.Trim(), geometry, createdAt);
        batch.RecordAudit("batch-created", "operator", null, null, null, null, createdAt);
        return Result<Batch>.Success(batch);
    }

    public Design? FindDesign(Guid designId)
        => _designs.FirstOrDefault(design => design.Id == designId);

    public Design? FindDesignByVersion(Guid versionId)
        => _designs.FirstOrDefault(design => design.FindVersion(versionId) is not null);

    public ExportRecord? FindExport(Guid exportId)
        => _exports.FirstOrDefault(export => export.Id == exportId);

    public Result Update(
        string? name,
        BatchGeometry? geometry,
        string actor,
        DateTimeOffset at)
    {
        if (name is not null)
        {
            var nameError = ValidateName(name);
            if (nameError is not null)
            {
                return Result.Failure(nameError);
            }

            Name = name.Trim();
        }

        var geometryChanged = false;
        if (geometry is not null && !Geometry.SameAs(geometry))
        {
            Geometry = geometry;
            geometryChanged = true;
        }

        if (geometryChanged)
        {
            InvalidateSheet(at);
            RecordAudit("batch-geometry-updated", actor, null, null, null, null, at);
        }

        Touch(at);
        return Result.Success();
    }

    public Result AddDesign(Design design, string actor, DateTimeOffset at)
    {
        if (design.BatchId != Id)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Design belongs to a different batch.");
        }

        if (_designs.Any(existing => existing.Id == design.Id))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "A design with this id already exists.");
        }

        _designs.Add(design);
        InvalidateSheet(at);
        RecordAudit("design-added", actor, null, design.Id, design.OriginalVersionId, null, at);
        Touch(at);
        return Result.Success();
    }

    public Result AddSheet(Sheet sheet, string actor, DateTimeOffset at)
    {
        if (sheet.BatchId != Id)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Sheet belongs to a different batch.");
        }

        if (_sheets.Any(existing => existing.Id == sheet.Id))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "A sheet with this id already exists.");
        }

        if (CurrentSheet is { } current && sheet.Revision <= current.Revision)
        {
            return Result.Failure(
                ErrorCodes.StaleRevision,
                $"Sheet revision {sheet.Revision} is not newer than the current revision {current.Revision}.");
        }

        _sheets.Add(sheet);
        RecordAudit("sheet-packed", actor, null, null, null, null, at);
        Touch(at);
        return Result.Success();
    }

    public Result AddExport(ExportRecord export, string actor, DateTimeOffset at)
    {
        if (export.BatchId != Id)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Export belongs to a different batch.");
        }

        if (_exports.Any(existing => existing.Id == export.Id))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "An export with this id already exists.");
        }

        _exports.Add(export);
        RecordAudit("export-requested", actor, null, null, null, null, at);
        Touch(at);
        return Result.Success();
    }

    /// <summary>Marks the current sheet stale. Placements are never mutated here.</summary>
    public void InvalidateSheet(DateTimeOffset at)
    {
        if (CurrentSheet is { Stale: false } sheet)
        {
            sheet.MarkStale(at);
            RecordAudit("sheet-invalidated", "system", null, null, null, null, at);
        }

        Touch(at);
    }

    /// <summary>Bumps the concurrency token, refreshes the derived status and timestamp.</summary>
    public void Touch(DateTimeOffset at)
    {
        RowVersion++;
        UpdatedAt = at;
        RefreshStatus();
    }

    public AuditEntry RecordAudit(
        string action,
        string actor,
        string? reason,
        Guid? designId,
        Guid? versionId,
        string? detailsJson,
        DateTimeOffset at)
    {
        var entry = AuditEntry.Create(Id, designId, versionId, action, actor, reason, detailsJson, at);
        _auditEntries.Add(entry);
        return entry;
    }

    private void RefreshStatus()
    {
        var sheet = CurrentSheet;
        if (sheet is { Stale: false, State: SheetState.Valid, IntegrityPassed: true })
        {
            if (_exports.Any(export =>
                    export.SheetId == sheet.Id
                    && export.SheetRevision == sheet.Revision
                    && export.Status == ExportStatus.Succeeded))
            {
                Status = BatchStatus.Exported;
                return;
            }

            Status = BatchStatus.Packed;
            return;
        }

        var included = IncludedDesigns;
        if (included.Count > 0 && included.All(design => design.Status == DesignStatus.Ready))
        {
            Status = BatchStatus.ReadyToPack;
            return;
        }

        Status = BatchStatus.Collecting;
    }

    private static DomainError? ValidateName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return DomainError.Create(ErrorCodes.InvalidRequest, "Batch name is required.");
        }

        if (name.Length > MaxNameLength)
        {
            return DomainError.Create(
                ErrorCodes.InvalidRequest,
                $"Batch name must be at most {MaxNameLength} characters.");
        }

        return null;
    }
}
