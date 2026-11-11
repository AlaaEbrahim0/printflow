using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.Abstractions;

/// <summary>Persistence and lease port for the jobs table.</summary>
public interface IJobRepository
{
    Task<Job?> FindAsync(Guid jobId, CancellationToken cancellationToken);

    Task<(IReadOnlyList<Job> Items, int Total)> ListByBatchAsync(
        Guid batchId,
        JobStatus? status,
        JobType? type,
        int limit,
        CancellationToken cancellationToken);

    /// <summary>Newest jobs across every batch — the global jobs screen.</summary>
    Task<(IReadOnlyList<Job> Items, int Total)> ListAllAsync(
        JobStatus? status,
        JobType? type,
        int limit,
        CancellationToken cancellationToken);

    Task<bool> HasActiveJobAsync(
        Guid batchId,
        JobType type,
        Guid? designId,
        CancellationToken cancellationToken);

    Task<bool> HasActiveStepJobAsync(Guid designId, CancellationToken cancellationToken);

    /// <summary>True when the batch still has queued or running jobs whose files are on disk.</summary>
    Task<bool> HasAnyActiveJobAsync(Guid batchId, CancellationToken cancellationToken);

    /// <summary>Deletes the jobs table rows for a batch (separate table, no cascade).</summary>
    Task DeleteByBatchAsync(Guid batchId, CancellationToken cancellationToken);

    void Add(Job job);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Transactional claim with lease recovery. The API feature layer decides
/// which capabilities a caller may request.
/// </summary>
public interface IJobQueue
{
    Task<Job?> ClaimAsync(
        string workerId,
        IReadOnlyList<JobCapability> capabilities,
        int leaseSeconds,
        bool workerJobsOnly,
        CancellationToken cancellationToken);
}
