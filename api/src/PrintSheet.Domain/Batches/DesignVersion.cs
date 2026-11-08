using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// One immutable processing result. Only the review status and its audit
/// timestamps may change after creation; files are write-once.
/// </summary>
public sealed class DesignVersion
{
    private DesignVersion()
    {
        FilePath = string.Empty;
        ParametersJson = "{}";
    }

    private DesignVersion(
        Guid id,
        Guid designId,
        Guid? parentId,
        StepType stepType,
        VersionStatus status,
        string filePath,
        string? maskPath,
        string? svgPath,
        int widthPx,
        int heightPx,
        bool hasAlpha,
        string parametersJson,
        Guid? jobId,
        DateTimeOffset createdAt)
    {
        Id = id;
        DesignId = designId;
        ParentId = parentId;
        StepType = stepType;
        Status = status;
        FilePath = filePath;
        MaskPath = maskPath;
        SvgPath = svgPath;
        WidthPx = widthPx;
        HeightPx = heightPx;
        HasAlpha = hasAlpha;
        ParametersJson = parametersJson;
        JobId = jobId;
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }

    public Guid DesignId { get; private set; }

    public Guid? ParentId { get; private set; }

    public StepType StepType { get; private set; }

    public VersionStatus Status { get; private set; }

    public string FilePath { get; private set; }

    public string? MaskPath { get; private set; }

    public string? SvgPath { get; private set; }

    public int WidthPx { get; private set; }

    public int HeightPx { get; private set; }

    public bool HasAlpha { get; private set; }

    /// <summary>Exact, immutable step parameters (including brush history).</summary>
    public string ParametersJson { get; private set; }

    public Guid? JobId { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? ApprovedAt { get; private set; }

    public DateTimeOffset? RejectedAt { get; private set; }

    public string? RejectionReason { get; private set; }

    public static Result<DesignVersion> CreateOriginal(
        Guid id,
        Guid designId,
        string filePath,
        int widthPx,
        int heightPx,
        bool hasAlpha,
        string parametersJson,
        DateTimeOffset createdAt)
    {
        var validation = ValidateFileMetadata(id, designId, filePath, widthPx, heightPx, parametersJson);
        if (!validation.IsSuccess)
        {
            return Result<DesignVersion>.Failure(validation.Error!);
        }

        return Result<DesignVersion>.Success(new DesignVersion(
            id,
            designId,
            parentId: null,
            StepType.Original,
            VersionStatus.Approved,
            filePath,
            maskPath: null,
            svgPath: null,
            widthPx,
            heightPx,
            hasAlpha,
            parametersJson,
            jobId: null,
            createdAt)
        {
            ApprovedAt = createdAt,
        });
    }

    public static Result<DesignVersion> CreateProposal(
        Guid id,
        Guid designId,
        Guid parentId,
        StepType stepType,
        string filePath,
        string? maskPath,
        string? svgPath,
        int widthPx,
        int heightPx,
        bool hasAlpha,
        string parametersJson,
        Guid jobId,
        DateTimeOffset createdAt)
    {
        var validation = ValidateFileMetadata(id, designId, filePath, widthPx, heightPx, parametersJson);
        if (!validation.IsSuccess)
        {
            return Result<DesignVersion>.Failure(validation.Error!);
        }

        if (parentId == Guid.Empty || jobId == Guid.Empty)
        {
            return Result<DesignVersion>.Failure(
                ErrorCodes.InvalidRequest,
                "A proposed version requires a parent and a producing job.");
        }

        if (stepType == StepType.Original)
        {
            return Result<DesignVersion>.Failure(
                ErrorCodes.InvalidRequest,
                "Only intake creates original versions.");
        }

        return Result<DesignVersion>.Success(new DesignVersion(
            id,
            designId,
            parentId,
            stepType,
            VersionStatus.Proposed,
            filePath,
            maskPath,
            svgPath,
            widthPx,
            heightPx,
            hasAlpha,
            parametersJson,
            jobId,
            createdAt));
    }

    /// <summary>
    /// An operator-prepared PNG that is already background-removed and exported
    /// at the exact target pixel size. It is stored as a separate immutable
    /// resize version (the file is copied, never referenced from the original)
    /// and starts approved because importing it is the explicit declaration
    /// that this is the ready-to-pack artwork. No pixels are re-encoded.
    /// </summary>
    public static Result<DesignVersion> CreateImportedResize(
        Guid id,
        Guid designId,
        Guid parentId,
        string filePath,
        int widthPx,
        int heightPx,
        bool hasAlpha,
        string parametersJson,
        DateTimeOffset createdAt)
    {
        var validation = ValidateFileMetadata(id, designId, filePath, widthPx, heightPx, parametersJson);
        if (!validation.IsSuccess)
        {
            return Result<DesignVersion>.Failure(validation.Error!);
        }

        if (parentId == Guid.Empty)
        {
            return Result<DesignVersion>.Failure(
                ErrorCodes.InvalidRequest,
                "An imported ready version requires the original as its parent.");
        }

        return Result<DesignVersion>.Success(new DesignVersion(
            id,
            designId,
            parentId,
            StepType.Resize,
            VersionStatus.Approved,
            filePath,
            maskPath: null,
            svgPath: null,
            widthPx,
            heightPx,
            hasAlpha,
            parametersJson,
            jobId: null,
            createdAt)
        {
            ApprovedAt = createdAt,
        });
    }

    internal Result Approve(DateTimeOffset at)
    {
        if (Status != VersionStatus.Proposed)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Only a proposed version can be approved (current status: {Status.ToContract()}).");
        }

        Status = VersionStatus.Approved;
        ApprovedAt = at;
        return Result.Success();
    }

    internal Result Reject(string? reason, DateTimeOffset at)
    {
        if (Status != VersionStatus.Proposed)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Only a proposed version can be rejected (current status: {Status.ToContract()}).");
        }

        Status = VersionStatus.Rejected;
        RejectedAt = at;
        RejectionReason = reason;
        return Result.Success();
    }

    private static Result ValidateFileMetadata(
        Guid id,
        Guid designId,
        string filePath,
        int widthPx,
        int heightPx,
        string parametersJson)
    {
        if (id == Guid.Empty || designId == Guid.Empty)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Version and design ids are required.");
        }

        if (string.IsNullOrWhiteSpace(filePath))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "A version file path is required.");
        }

        if (widthPx < 1 || heightPx < 1)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Version dimensions must be positive.");
        }

        if (string.IsNullOrWhiteSpace(parametersJson))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Version parameters must be valid JSON.");
        }

        return Result.Success();
    }
}
