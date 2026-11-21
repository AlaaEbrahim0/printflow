using PrintSheet.Application.Abstractions;

namespace PrintSheet.Application.Services;

/// <summary>
/// Adapts the worker-protocol completion service to the runner's port, so the
/// runner depends on an abstraction while the API keeps exactly one completion
/// path: an in-process cutout is validated and versioned like any worker result.
/// </summary>
public sealed class JobCompletionAdapter(JobCompletionService completion) : IJobCompletionPort
{
    public Task<Domain.Common.Result> CompleteAsync(
        Guid jobId,
        string leaseToken,
        System.Text.Json.JsonElement result,
        CancellationToken cancellationToken)
        => completion.CompleteAsync(jobId, leaseToken, result, cancellationToken);

    public Task<Domain.Common.Result> FailAsync(
        Guid jobId,
        string leaseToken,
        Domain.Jobs.JobError error,
        CancellationToken cancellationToken)
        => completion.FailAsync(jobId, leaseToken, error, cancellationToken);
}
