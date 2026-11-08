using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Jobs;

/// <summary>
/// A leased unit of work. Jobs are not owned by the batch aggregate because
/// workers update them concurrently; the API applies results in their own
/// transaction.
/// </summary>
public sealed class Job
{
    public const int DefaultMaxAttempts = 3;

    private Job()
    {
        ParametersJson = "{}";
        ContextJson = "{}";
        InputArtifactsJson = "{}";
        OutputArtifactsJson = "{}";
    }

    private Job(
        Guid id,
        Guid batchId,
        Guid? designId,
        JobType type,
        JobCapability capability,
        string parametersJson,
        string contextJson,
        string? inputPath,
        string? outputPath,
        string inputArtifactsJson,
        string outputArtifactsJson,
        int maxAttempts,
        DateTimeOffset createdAt)
    {
        Id = id;
        BatchId = batchId;
        DesignId = designId;
        Type = type;
        Capability = capability;
        Status = JobStatus.Queued;
        ParametersJson = parametersJson;
        ContextJson = contextJson;
        InputPath = inputPath;
        OutputPath = outputPath;
        InputArtifactsJson = inputArtifactsJson;
        OutputArtifactsJson = outputArtifactsJson;
        Attempts = 0;
        MaxAttempts = maxAttempts;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }

    public Guid BatchId { get; private set; }

    public Guid? DesignId { get; private set; }

    public JobType Type { get; private set; }

    public JobCapability Capability { get; private set; }

    public JobStatus Status { get; private set; }

    /// <summary>Type-specific worker parameters, exactly as the worker received them.</summary>
    public string ParametersJson { get; private set; }

    /// <summary>Snapshot used to validate the result (target size, parent version, sheet revision).</summary>
    public string ContextJson { get; private set; }

    public string? InputPath { get; private set; }

    public string? OutputPath { get; private set; }

    public string InputArtifactsJson { get; private set; }

    public string OutputArtifactsJson { get; private set; }

    public int Attempts { get; private set; }

    public int MaxAttempts { get; private set; }

    public string? LeaseOwner { get; private set; }

    public string? LeaseToken { get; private set; }

    public DateTimeOffset? LeaseExpiresAt { get; private set; }

    public string? ResultJson { get; private set; }

    public string? ErrorJson { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    public DateTimeOffset? StartedAt { get; private set; }

    public DateTimeOffset? CompletedAt { get; private set; }

    public int? DurationMs { get; private set; }

    public static Result<Job> Create(
        Guid id,
        Guid batchId,
        Guid? designId,
        JobType type,
        JobCapability capability,
        string parametersJson,
        string contextJson,
        string? inputPath,
        string? outputPath,
        string inputArtifactsJson,
        string outputArtifactsJson,
        int maxAttempts,
        DateTimeOffset createdAt)
    {
        if (id == Guid.Empty || batchId == Guid.Empty)
        {
            return Result<Job>.Failure(ErrorCodes.InvalidRequest, "Job and batch ids are required.");
        }

        if (maxAttempts < 1 || maxAttempts > 100)
        {
            return Result<Job>.Failure(ErrorCodes.InvalidRequest, "Max attempts is out of range.");
        }

        return Result<Job>.Success(new Job(
            id,
            batchId,
            designId,
            type,
            capability,
            string.IsNullOrWhiteSpace(parametersJson) ? "{}" : parametersJson,
            string.IsNullOrWhiteSpace(contextJson) ? "{}" : contextJson,
            inputPath,
            outputPath,
            string.IsNullOrWhiteSpace(inputArtifactsJson) ? "{}" : inputArtifactsJson,
            string.IsNullOrWhiteSpace(outputArtifactsJson) ? "{}" : outputArtifactsJson,
            maxAttempts,
            createdAt));
    }

    public bool IsWorkerJob => Type is JobType.Classify
        or JobType.Trim
        or JobType.BackgroundRemoval
        or JobType.Upscale
        or JobType.Vectorize
        or JobType.Resize;

    public Result TryClaim(string workerId, string leaseToken, int leaseSeconds, DateTimeOffset now)
    {
        if (Status != JobStatus.Queued)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Only a queued job can be claimed (current status: {Status.ToContract()}).");
        }

        if (string.IsNullOrWhiteSpace(workerId) || string.IsNullOrWhiteSpace(leaseToken))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Worker id and lease token are required.");
        }

        if (leaseSeconds is < 15 or > 900)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Lease duration must be between 15 and 900 seconds.");
        }

        Status = JobStatus.Running;
        Attempts++;
        LeaseOwner = workerId;
        LeaseToken = leaseToken;
        LeaseExpiresAt = now.AddSeconds(leaseSeconds);
        StartedAt = now;
        CompletedAt = null;
        DurationMs = null;
        UpdatedAt = now;
        return Result.Success();
    }

    public Result ExtendLease(string leaseToken, int extendSeconds, DateTimeOffset now)
    {
        if (Status != JobStatus.Running
            || LeaseToken != leaseToken
            || LeaseExpiresAt is null
            || LeaseExpiresAt <= now)
        {
            return Result.Failure(
                ErrorCodes.LeaseInvalid,
                "The lease is missing, expired or owned by another worker.");
        }

        if (extendSeconds is < 15 or > 900)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Lease duration must be between 15 and 900 seconds.");
        }

        LeaseExpiresAt = now.AddSeconds(extendSeconds);
        UpdatedAt = now;
        return Result.Success();
    }

    public Result Complete(string leaseToken, string resultJson, DateTimeOffset now)
    {
        if (Status != JobStatus.Running || LeaseToken != leaseToken)
        {
            return Result.Failure(
                ErrorCodes.LeaseInvalid,
                "The lease is missing or owned by another worker.");
        }

        if (LeaseExpiresAt is not null && LeaseExpiresAt <= now)
        {
            return Result.Failure(ErrorCodes.LeaseInvalid, "The lease has expired.");
        }

        Status = JobStatus.Succeeded;
        ResultJson = resultJson;
        CompletedAt = now;
        DurationMs = StartedAt is null ? null : (int)Math.Max(0, (now - StartedAt.Value).TotalMilliseconds);
        ClearLease();
        UpdatedAt = now;
        return Result.Success();
    }

    public Result Fail(string leaseToken, JobError error, DateTimeOffset now)
    {
        if (Status != JobStatus.Running || LeaseToken != leaseToken)
        {
            return Result.Failure(
                ErrorCodes.LeaseInvalid,
                "The lease is missing or owned by another worker.");
        }

        ErrorJson = System.Text.Json.JsonSerializer.Serialize(error);
        ClearLease();
        UpdatedAt = now;

        if (error.Retryable && Attempts < MaxAttempts)
        {
            Status = JobStatus.Queued;
            StartedAt = null;
            CompletedAt = null;
            DurationMs = null;
            return Result.Success();
        }

        Status = JobStatus.Failed;
        CompletedAt = now;
        DurationMs = StartedAt is null ? null : (int)Math.Max(0, (now - StartedAt.Value).TotalMilliseconds);
        return Result.Success();
    }

    public Result Cancel(DateTimeOffset now)
    {
        if (Status != JobStatus.Queued)
        {
            return Result.Failure(
                ErrorCodes.JobNotCancellable,
                "Only a queued job can be cancelled.");
        }

        Status = JobStatus.Cancelled;
        CompletedAt = now;
        UpdatedAt = now;
        return Result.Success();
    }

    /// <summary>Requeues a job whose lease expired. Returns true when it was recovered.</summary>
    public bool RecoverExpiredLease(DateTimeOffset now)
    {
        if (Status != JobStatus.Running || LeaseExpiresAt is null || LeaseExpiresAt > now)
        {
            return false;
        }

        ClearLease();
        UpdatedAt = now;
        if (Attempts < MaxAttempts)
        {
            Status = JobStatus.Queued;
            StartedAt = null;
            return true;
        }

        Status = JobStatus.Failed;
        ErrorJson = System.Text.Json.JsonSerializer.Serialize(
            JobError.Create("lease-expired", "The lease expired and no attempts remain.", retryable: false));
        CompletedAt = now;
        return true;
    }

    private void ClearLease()
    {
        LeaseOwner = null;
        LeaseToken = null;
        LeaseExpiresAt = null;
    }
}

/// <summary>Structured, retry-aware job failure reported by a worker.</summary>
public sealed record JobError(
    string Code,
    string Message,
    bool Retryable,
    string? DetailsJson)
{
    public static JobError Create(string code, string message, bool retryable, string? detailsJson = null)
        => new(code, message, retryable, detailsJson);
}
