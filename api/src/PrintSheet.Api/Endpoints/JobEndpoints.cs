using System.Text.Json;
using PrintSheet.Api.Contracts;
using PrintSheet.Application.Jobs;
using PrintSheet.Application.Services;
using PrintSheet.Domain.Common;

namespace PrintSheet.Api.Endpoints;

/// <summary>
/// Job polling plus the internal worker lease protocol. Only these paths are
/// needed to move work through the system; pack/integrity/export jobs are
/// applied by the application services when the packer runner reports results.
/// </summary>
public static class JobEndpoints
{
    public static void MapJobEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/jobs", ListAllAsync).WithTags("Jobs");
        app.MapGet("/api/v1/jobs/{jobId:guid}", GetAsync).WithTags("Jobs");
        app.MapPost("/api/v1/jobs/{jobId:guid}/cancel", CancelAsync).WithTags("Jobs");
        app.MapGet("/api/v1/batches/{batchId:guid}/jobs", ListAsync).WithTags("Jobs");

        var worker = app.MapGroup("/api/v1/internal/jobs")
            .WithTags("Worker protocol")
            .AddEndpointFilter<WorkerKeyEndpointFilter>();

        worker.MapPost("/claim", ClaimAsync);
        worker.MapPost("/{jobId:guid}/heartbeat", HeartbeatAsync);
        worker.MapPost("/{jobId:guid}/complete", CompleteAsync);
        worker.MapPost("/{jobId:guid}/fail", FailAsync);
    }

    private static async Task<IResult> GetAsync(
        Guid jobId,
        JobService jobs,
        CancellationToken cancellationToken)
    {
        var result = await jobs.GetAsync(jobId, cancellationToken);
        return result.IsSuccess
            ? Results.Ok(result.Value!.ToDto())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> CancelAsync(
        Guid jobId,
        JobService jobs,
        CancellationToken cancellationToken)
    {
        var result = await jobs.CancelAsync(jobId, cancellationToken);
        return result.IsSuccess
            ? Results.Ok(result.Value!.ToDto())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> ListAllAsync(
        JobService jobs,
        string? status,
        string? type,
        int limit = 200,
        CancellationToken cancellationToken = default)
    {
        var filters = ParseFilters(status, type);
        if (filters.Error is not null)
        {
            return filters.Error;
        }

        var result = await jobs.ListAllAsync(
            filters.Status,
            filters.Type,
            limit,
            cancellationToken);

        return result.IsSuccess
            ? Results.Ok(new JobListDto(
                result.Value.Items.Select(job => job.ToDto()).ToList(),
                result.Value.Total))
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> ListAsync(
        Guid batchId,
        JobService jobs,
        string? status,
        string? type,
        int limit = 50,
        CancellationToken cancellationToken = default)
    {
        var filters = ParseFilters(status, type);
        if (filters.Error is not null)
        {
            return filters.Error;
        }

        var result = await jobs.ListForBatchAsync(
            batchId,
            filters.Status,
            filters.Type,
            limit,
            cancellationToken);

        return result.IsSuccess
            ? Results.Ok(new JobListDto(
                result.Value.Items.Select(job => job.ToDto()).ToList(),
                result.Value.Total))
            : ApiResults.Problem(result.Error!);
    }

    private static (Domain.Batches.JobStatus? Status, Domain.Batches.JobType? Type, IResult? Error)
        ParseFilters(string? status, string? type)
    {
        Domain.Batches.JobStatus? parsedStatus = null;
        if (!string.IsNullOrWhiteSpace(status))
        {
            if (!ApiResults.TryParseJobStatus(status, out var value))
            {
                return (null, null, ApiResults.Problem(
                    ErrorCodes.InvalidRequest,
                    $"Unknown job status '{status}'."));
            }

            parsedStatus = value;
        }

        Domain.Batches.JobType? parsedType = null;
        if (!string.IsNullOrWhiteSpace(type))
        {
            if (!ApiResults.TryParseJobType(type, out var value))
            {
                return (null, null, ApiResults.Problem(
                    ErrorCodes.InvalidRequest,
                    $"Unknown job type '{type}'."));
            }

            parsedType = value;
        }

        return (parsedStatus, parsedType, null);
    }

    private static async Task<IResult> ClaimAsync(
        ClaimJobsRequest request,
        JobService jobs,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.WorkerId) || request.Capabilities is null)
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "workerId and capabilities are required.");
        }

        var result = await jobs.ClaimAsync(
            new ClaimJobsCommand(
                request.WorkerId,
                request.Capabilities,
                request.LeaseSeconds ?? 120),
            cancellationToken);

        if (!result.IsSuccess)
        {
            return ApiResults.Problem(result.Error!);
        }

        if (result.Value is null)
        {
            return Results.NoContent();
        }

        var claimed = result.Value;
        var job = claimed.Job;
        return Results.Ok(new JobAssignmentDto(
            claimed.LeaseToken,
            claimed.LeaseExpiresAt,
            new WorkerJobDto(
                job.SchemaVersion,
                job.JobId,
                job.Type,
                job.BatchId,
                job.DesignId,
                job.InputPath,
                job.OutputPath,
                job.InputArtifacts,
                job.OutputArtifacts,
                job.Parameters,
                job.Context)));
    }

    private static async Task<IResult> HeartbeatAsync(
        Guid jobId,
        HeartbeatRequest request,
        JobService jobs,
        CancellationToken cancellationToken)
    {
        var result = await jobs.HeartbeatAsync(
            jobId,
            request.LeaseToken,
            request.ExtendSeconds ?? 120,
            cancellationToken);

        return result.IsSuccess ? Results.NoContent() : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> CompleteAsync(
        Guid jobId,
        WorkerCompletionRequest request,
        JobService jobs,
        CancellationToken cancellationToken)
    {
        var result = await jobs.CompleteAsync(
            jobId,
            request.LeaseToken,
            request.Result,
            cancellationToken);

        return result.IsSuccess ? Results.NoContent() : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> FailAsync(
        Guid jobId,
        JobFailureRequest request,
        JobService jobs,
        CancellationToken cancellationToken)
    {
        if (request.Error is null)
        {
            return ApiResults.Problem(ErrorCodes.InvalidRequest, "error is required.");
        }

        var details = request.Error.Details is { } detailsElement
            ? detailsElement.GetRawText()
            : null;
        var error = Domain.Jobs.JobError.Create(
            request.Error.Code,
            request.Error.Message,
            request.Error.Retryable,
            details);

        var result = await jobs.FailAsync(jobId, request.LeaseToken, error, cancellationToken);
        return result.IsSuccess ? Results.NoContent() : ApiResults.Problem(result.Error!);
    }
}
