using System.Text.Json;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.Abstractions;

/// <summary>
/// The worker-protocol completion handshake, expressed as a port so an in-process
/// runner can finish a job through the same validation path a worker uses without
/// depending on the concrete application service.
/// </summary>
public interface IJobCompletionPort
{
    Task<Result> CompleteAsync(
        Guid jobId,
        string leaseToken,
        JsonElement result,
        CancellationToken cancellationToken);

    Task<Result> FailAsync(
        Guid jobId,
        string leaseToken,
        JobError error,
        CancellationToken cancellationToken);
}
