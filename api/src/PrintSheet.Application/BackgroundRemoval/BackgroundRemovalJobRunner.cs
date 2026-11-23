using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Common;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>
/// Executes one queued <see cref="Domain.Batches.JobType.BackgroundRemoval"/> job
/// in the API.
///
/// The provider adapters, the crop/upscale worker clients and the alpha refiner
/// all live behind application ports, so the job is leased and completed exactly
/// like a worker job but never leaves the process. It is invoked by a hosted
/// service, never by a request: a full pipeline run is 30-90 s on the reference
/// workstation, far past a sensible HTTP timeout.
/// </summary>
public sealed class BackgroundRemovalJobRunner
{
    /// <summary>Worker-protocol lease; long enough for a cold provider plus two upscales.</summary>
    public const int LeaseSeconds = 900;

    private const string RunnerWorkerId = "api-cutout";

    private readonly IJobQueue _queue;
    private readonly IBatchRepository _batches;
    private readonly IFileStore _files;
    private readonly IBackgroundRemovalPipeline _pipeline;
    private readonly IJobCompletionPort _completion;
    private readonly ILogger<BackgroundRemovalJobRunner> _logger;

    public BackgroundRemovalJobRunner(
        IJobQueue queue,
        IBatchRepository batches,
        IFileStore files,
        IBackgroundRemovalPipeline pipeline,
        IJobCompletionPort completion,
        ILogger<BackgroundRemovalJobRunner> logger)
    {
        _queue = queue;
        _batches = batches;
        _files = files;
        _pipeline = pipeline;
        _completion = completion;
        _logger = logger;
    }

    /// <summary>
    /// Claims and runs at most one job. Returns <c>null</c> when nothing was
    /// queued, which lets the caller idle without inventing a failure.
    /// </summary>
    public async Task<Guid?> RunNextAsync(CancellationToken cancellationToken)
    {
        var job = await _queue.ClaimAsync(
            RunnerWorkerId,
            [JobCapability.Cutout],
            LeaseSeconds,
            workerJobsOnly: false,
            cancellationToken);

        if (job is null)
        {
            return null;
        }

        if (job.LeaseToken is not { Length: > 0 } leaseToken)
        {
            _logger.LogError("Claimed job {JobId} without a lease token; refusing to run it.", job.Id);
            return job.Id;
        }

        try
        {
            await RunAsync(job, leaseToken, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Shutdown: the lease expires on its own and the job is retried.
            throw;
        }
        catch (Exception exception)
        {
            // The runner must never lose a job to an unhandled exception: report it
            // as a failure so the job ends in a terminal, visible state.
            _logger.LogError(exception, "Background-removal job {JobId} crashed.", job.Id);
            await _completion.FailAsync(
                job.Id,
                leaseToken,
                JobError.Create(
                    "background-removal-failed",
                    "The background-removal runner failed unexpectedly.",
                    retryable: true),
                CancellationToken.None);
        }

        return job.Id;
    }

    private async Task RunAsync(Job job, string leaseToken, CancellationToken cancellationToken)
    {
        var prepared = await PrepareAsync(job, cancellationToken);
        if (!prepared.IsSuccess)
        {
            await FailAsync(job, leaseToken, prepared.Error!, cancellationToken);
            return;
        }

        var (input, sourceVersionId, outputPath) = prepared.Value;

        BackgroundRemovalPipelineResult result;
        try
        {
            // The override was validated when the job was queued; the runner only
            // needs to forward it so the job runs on the provider the operator chose.
            // preserveSize was decided at queue time from the parent's pixel size.
            result = await _pipeline.RunAsync(
                input,
                cancellationToken,
                ReadProviderOverride(job),
                ReadPreserveSize(job));
        }
        catch (BackgroundRemovalException exception)
        {
            _logger.LogWarning(
                "Background removal failed for job {JobId} via {Provider}: {Reason}.",
                job.Id,
                exception.Provider,
                exception.Reason);

            await FailAsync(
                job,
                leaseToken,
                new DomainError(
                    "background-removal-failed",
                    exception.Message,
                    new Dictionary<string, object?> { ["retryable"] = exception.AllowsFallback }),
                cancellationToken);
            return;
        }

        // The result must be on disk under the job's output path before completion,
        // because the completion service verifies and versions that exact file.
        await using (var stream = new MemoryStream(result.PngBytes, writable: false))
        {
            await _files.WriteAsync(outputPath, stream, cancellationToken);
        }

        var completionResult = await _completion.CompleteAsync(
            job.Id,
            leaseToken,
            BuildResult(job, result, outputPath, sourceVersionId),
            cancellationToken);

        if (!completionResult.IsSuccess)
        {
            _logger.LogWarning(
                "Background-removal result for job {JobId} was rejected: {Code} {Message}",
                job.Id,
                completionResult.Error!.Code,
                completionResult.Error.Message);
        }
    }

    /// <summary>
    /// Reads the immutable input and resolves the target path. The output path was
    /// assigned when the job was queued and already ends in the new version id,
    /// which is how the completion service reads the version back.
    /// </summary>
    private async Task<Result<(ImageInput Input, Guid SourceVersionId, string OutputPath)>> PrepareAsync(
        Job job,
        CancellationToken cancellationToken)
    {
        if (job.DesignId is not { } designId)
        {
            return Invalid("A background-removal job must target a design.");
        }

        if (string.IsNullOrWhiteSpace(job.OutputPath))
        {
            return Invalid("The job has no output path.");
        }

        var batch = await _batches.FindByDesignAsync(designId, cancellationToken);
        var design = batch?.FindDesign(designId);
        if (design is null)
        {
            return Result<(ImageInput, Guid, string)>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        if (design.CurrentVersion is not { } parent)
        {
            return Invalid("The design has no current version to remove a background from.");
        }

        if (string.IsNullOrWhiteSpace(parent.FilePath))
        {
            return Invalid("The current version has no file on disk.");
        }

        byte[] bytes;
        await using (var stream = await _files.OpenReadAsync(parent.FilePath, cancellationToken))
        {
            using var buffer = new MemoryStream();
            await stream.CopyToAsync(buffer, cancellationToken);
            bytes = buffer.ToArray();
        }

        if (bytes.Length == 0)
        {
            return Invalid("The current version file is empty.");
        }

        // Version files are always PNG in this system, so the content type is known
        // rather than guessed from a possibly stale extension.
        var input = new ImageInput(bytes, "image/png", Path.GetFileName(parent.FilePath));
        return Result<(ImageInput, Guid, string)>.Success((input, parent.Id, job.OutputPath));
    }

    private static JsonElement BuildResult(
        Job job,
        BackgroundRemovalPipelineResult result,
        string outputPath,
        Guid sourceVersionId)
    {
        var document = new JsonObject
        {
            ["schemaVersion"] = "1.0",
            ["jobId"] = job.Id,
            ["status"] = "succeeded",
            ["outputPath"] = outputPath,
            ["outputArtifacts"] = new JsonObject(),
            ["metadata"] = new JsonObject
            {
                ["widthPx"] = result.WidthPx,
                ["heightPx"] = result.HeightPx,
                // hasAlpha is deliberately not reported: the completion service
                // inspects the file on disk and that is the only claim it can verify.
                // A hardcoded `true` here would win over the inspection and could
                // record transparency the file does not have.
                ["provider"] = result.Provider,
                ["durationMs"] = (int)result.TotalElapsed.TotalMilliseconds,
                ["removalMs"] = (int)result.RemovalElapsed.TotalMilliseconds,
                ["sourceVersionId"] = sourceVersionId,
            },
        };

        using var parsed = JsonDocument.Parse(document.ToJsonString(ApplicationJson.Web));
        return parsed.RootElement.Clone();
    }

    private Task FailAsync(
        Job job,
        string leaseToken,
        DomainError error,
        CancellationToken cancellationToken)
    {
        var retryable = error.Details is { } details
            && details.TryGetValue("retryable", out var value)
            && value is true;

        return _completion.FailAsync(
            job.Id,
            leaseToken,
            JobError.Create(error.Code, error.Message, retryable),
            cancellationToken);
    }

    private static Result<(ImageInput, Guid, string)> Invalid(string message)
        => Result<(ImageInput, Guid, string)>.Failure(ErrorCodes.InvalidRequest, message);

    /// <summary>
    /// The per-job provider override, if the operator supplied one when queueing.
    /// StepService omits the property entirely when no override was given, so an
    /// absent or blank value means "use the configured default".
    /// </summary>
    private static string? ReadProviderOverride(Job job)
    {
        using var parameters = JsonDocument.Parse(job.ParametersJson);
        return parameters.RootElement.ValueKind == JsonValueKind.Object
            && parameters.RootElement.TryGetProperty("provider", out var provider)
            && provider.ValueKind == JsonValueKind.String
            ? provider.GetString()
            : null;
    }

    /// <summary>
    /// Whether the cut-out must keep the parent's exact pixel dimensions. Absent
    /// means false: an older job, or one queued before print size was set, takes
    /// the crop-then-upscale path.
    /// </summary>
    private static bool ReadPreserveSize(Job job)
    {
        using var parameters = JsonDocument.Parse(job.ParametersJson);
        return parameters.RootElement.ValueKind == JsonValueKind.Object
            && parameters.RootElement.TryGetProperty("preserveSize", out var preserve)
            && preserve.ValueKind is JsonValueKind.True or JsonValueKind.False
            && preserve.GetBoolean();
    }
}
