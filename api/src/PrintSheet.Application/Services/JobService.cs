using System.Text.Json;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Common;
using PrintSheet.Application.Jobs;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.Services;

public sealed class JobService
{
    private readonly IJobRepository _jobs;
    private readonly IJobQueue _queue;
    private readonly IBatchRepository _batches;
    private readonly JobCompletionService _completion;
    private readonly IClock _clock;

    public JobService(
        IJobRepository jobs,
        IJobQueue queue,
        IBatchRepository batches,
        JobCompletionService completion,
        IClock clock)
    {
        _jobs = jobs;
        _queue = queue;
        _batches = batches;
        _completion = completion;
        _clock = clock;
    }

    public async Task<Result<Job>> GetAsync(Guid jobId, CancellationToken cancellationToken)
    {
        var job = await _jobs.FindAsync(jobId, cancellationToken);
        return job is null
            ? Result<Job>.Failure(ErrorCodes.JobNotFound, $"Job {jobId} was not found.")
            : Result<Job>.Success(job);
    }

    public async Task<Result<(IReadOnlyList<Job> Items, int Total)>> ListForBatchAsync(
        Guid batchId,
        JobStatus? status,
        JobType? type,
        int limit,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<(IReadOnlyList<Job>, int)>.Failure(
                ErrorCodes.BatchNotFound,
                $"Batch {batchId} was not found.");
        }

        var result = await _jobs.ListByBatchAsync(
            batchId,
            status,
            type,
            Math.Clamp(limit, 1, 200),
            cancellationToken);
        return Result<(IReadOnlyList<Job>, int)>.Success(result);
    }

    public async Task<Result<(IReadOnlyList<Job> Items, int Total)>> ListAllAsync(
        JobStatus? status,
        JobType? type,
        int limit,
        CancellationToken cancellationToken)
    {
        var result = await _jobs.ListAllAsync(
            status,
            type,
            Math.Clamp(limit, 1, 200),
            cancellationToken);
        return Result<(IReadOnlyList<Job>, int)>.Success(result);
    }

    public async Task<Result<Job>> CancelAsync(
        Guid jobId,
        CancellationToken cancellationToken)
    {
        var job = await _jobs.FindAsync(jobId, cancellationToken);
        if (job is null)
        {
            return Result<Job>.Failure(ErrorCodes.JobNotFound, $"Job {jobId} was not found.");
        }

        var cancel = job.Cancel(_clock.UtcNow);
        if (!cancel.IsSuccess)
        {
            return Result<Job>.Failure(cancel.Error!);
        }

        await _jobs.SaveChangesAsync(cancellationToken);
        return Result<Job>.Success(job);
    }

    public async Task<Result<ClaimedJob?>> ClaimAsync(
        ClaimJobsCommand command,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(command.WorkerId))
        {
            return Result<ClaimedJob?>.Failure(ErrorCodes.InvalidRequest, "Worker id is required.");
        }

        var capabilities = new List<JobCapability>();
        foreach (var capability in command.Capabilities)
        {
            var parsed = capability switch
            {
                "image" => JobCapability.Image,
                "gpu" => JobCapability.Gpu,
                "packer" => JobCapability.Packer,
                "export" => JobCapability.Export,
                _ => (JobCapability?)null,
            };

            if (parsed is null)
            {
                return Result<ClaimedJob?>.Failure(
                    ErrorCodes.InvalidRequest,
                    $"Unknown capability '{capability}'.");
            }

            capabilities.Add(parsed.Value);
        }

        if (capabilities.Count == 0)
        {
            return Result<ClaimedJob?>.Failure(
                ErrorCodes.InvalidRequest,
                "At least one capability is required.");
        }

        var job = await _queue.ClaimAsync(
            command.WorkerId,
            capabilities,
            command.LeaseSeconds,
            // Capabilities already isolate image workers from packer/export
            // workers; a pack job must be claimable for the sheet flow to end.
            workerJobsOnly: false,
            cancellationToken);

        if (job is null)
        {
            return Result<ClaimedJob?>.Success(null);
        }

        var parameters = Parse(job.ParametersJson);
        var context = Parse(job.ContextJson);
        var inputArtifacts = ParseMap(job.InputArtifactsJson);
        var outputArtifacts = ParseMap(job.OutputArtifactsJson);

        var envelope = new WorkerJobEnvelope(
            "1.0",
            job.Id,
            job.Type.ToContract(),
            job.BatchId,
            job.DesignId ?? Guid.Empty,
            job.InputPath ?? string.Empty,
            job.OutputPath,
            inputArtifacts,
            outputArtifacts,
            parameters,
            context);

        return Result<ClaimedJob?>.Success(new ClaimedJob(
            job.LeaseToken ?? string.Empty,
            job.LeaseExpiresAt ?? _clock.UtcNow,
            envelope));
    }

    public async Task<Result> HeartbeatAsync(
        Guid jobId,
        string leaseToken,
        int extendSeconds,
        CancellationToken cancellationToken)
    {
        var job = await _jobs.FindAsync(jobId, cancellationToken);
        if (job is null)
        {
            return Result.Failure(ErrorCodes.JobNotFound, $"Job {jobId} was not found.");
        }

        var heartbeat = job.ExtendLease(leaseToken, extendSeconds, _clock.UtcNow);
        if (!heartbeat.IsSuccess)
        {
            return heartbeat;
        }

        await _jobs.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }

    public Task<Result> CompleteAsync(
        Guid jobId,
        string leaseToken,
        JsonElement result,
        CancellationToken cancellationToken)
        => _completion.CompleteAsync(jobId, leaseToken, result, cancellationToken);

    public Task<Result> FailAsync(
        Guid jobId,
        string leaseToken,
        JobError error,
        CancellationToken cancellationToken)
        => _completion.FailAsync(jobId, leaseToken, error, cancellationToken);

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static IReadOnlyDictionary<string, string> ParseMap(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json, ApplicationJson.Web)
                   ?? new Dictionary<string, string>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>();
        }
    }
}
