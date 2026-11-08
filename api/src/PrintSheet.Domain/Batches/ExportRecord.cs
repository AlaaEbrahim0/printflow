using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>A rendered deliverable for one sheet revision.</summary>
public sealed class ExportRecord
{
    private readonly List<ExportArtifact> _artifacts = [];

    private ExportRecord()
    {
        IntegrityReportJson = null;
    }

    private ExportRecord(
        Guid id,
        Guid batchId,
        Guid sheetId,
        int sheetRevision,
        ExportFormat format,
        int dpi,
        string integrityReportJson,
        DateTimeOffset createdAt)
    {
        Id = id;
        BatchId = batchId;
        SheetId = sheetId;
        SheetRevision = sheetRevision;
        Format = format;
        Status = ExportStatus.Queued;
        Dpi = dpi;
        IntegrityReportJson = integrityReportJson;
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }

    public Guid BatchId { get; private set; }

    public Guid SheetId { get; private set; }

    public int SheetRevision { get; private set; }

    public ExportFormat Format { get; private set; }

    public ExportStatus Status { get; private set; }

    public int Dpi { get; private set; }

    public IReadOnlyList<ExportArtifact> Artifacts => _artifacts;

    public string? IntegrityReportJson { get; private set; }

    public string? BlockedReason { get; private set; }

    public string? ErrorJson { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? CompletedAt { get; private set; }

    public static Result<ExportRecord> CreateQueued(
        Guid id,
        Guid batchId,
        Guid sheetId,
        int sheetRevision,
        ExportFormat format,
        int dpi,
        string integrityReportJson,
        DateTimeOffset createdAt)
    {
        if (id == Guid.Empty || batchId == Guid.Empty || sheetId == Guid.Empty)
        {
            return Result<ExportRecord>.Failure(ErrorCodes.InvalidRequest, "Export ids are required.");
        }

        if (sheetRevision < 1 || dpi is < 72 or > 1200)
        {
            return Result<ExportRecord>.Failure(
                ErrorCodes.InvalidRequest,
                "Export sheet revision or DPI is invalid.");
        }

        if (string.IsNullOrWhiteSpace(integrityReportJson))
        {
            return Result<ExportRecord>.Failure(
                ErrorCodes.SheetIntegrityFailed,
                "An export requires the passed integrity report for this sheet revision.");
        }

        return Result<ExportRecord>.Success(new ExportRecord(
            id,
            batchId,
            sheetId,
            sheetRevision,
            format,
            dpi,
            integrityReportJson,
            createdAt));
    }

    public Result MarkRunning(DateTimeOffset at)
    {
        if (Status != ExportStatus.Queued)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Only a queued export can start (current status: {Status.ToContract()}).");
        }

        Status = ExportStatus.Running;
        _ = at;
        return Result.Success();
    }

    public Result MarkSucceeded(IReadOnlyList<ExportArtifact> artifacts, DateTimeOffset at)
    {
        if (Status is not (ExportStatus.Queued or ExportStatus.Running))
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Only a queued or running export can succeed (current status: {Status.ToContract()}).");
        }

        if (artifacts.Count == 0)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "An export must produce at least one artifact.");
        }

        _artifacts.Clear();
        _artifacts.AddRange(artifacts);
        Status = ExportStatus.Succeeded;
        CompletedAt = at;
        return Result.Success();
    }

    public Result MarkFailed(string errorJson, DateTimeOffset at)
    {
        if (Status is ExportStatus.Succeeded or ExportStatus.Blocked)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"A {Status.ToContract()} export cannot fail again.");
        }

        ErrorJson = errorJson;
        Status = ExportStatus.Failed;
        CompletedAt = at;
        return Result.Success();
    }

    public Result MarkBlocked(string reason, DateTimeOffset at)
    {
        if (Status is ExportStatus.Succeeded or ExportStatus.Failed)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"A {Status.ToContract()} export cannot be blocked.");
        }

        BlockedReason = reason;
        Status = ExportStatus.Blocked;
        CompletedAt = at;
        return Result.Success();
    }
}

/// <summary>One downloadable file produced by an export.</summary>
public sealed record ExportArtifact(
    ExportArtifactName Name,
    string ContentType,
    long SizeBytes,
    string StoragePath)
{
    public static Result<ExportArtifact> Create(
        ExportArtifactName name,
        string contentType,
        long sizeBytes,
        string storagePath)
    {
        if (string.IsNullOrWhiteSpace(contentType) || string.IsNullOrWhiteSpace(storagePath))
        {
            return Result<ExportArtifact>.Failure(
                ErrorCodes.InvalidRequest,
                "An artifact requires a content type and a storage path.");
        }

        if (sizeBytes < 0)
        {
            return Result<ExportArtifact>.Failure(
                ErrorCodes.InvalidRequest,
                "Artifact size must not be negative.");
        }

        return Result<ExportArtifact>.Success(new ExportArtifact(name, contentType, sizeBytes, storagePath));
    }
}
