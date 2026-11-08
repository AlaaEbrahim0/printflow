using System.Data;
using Microsoft.EntityFrameworkCore;
using PrintSheet.Application.Abstractions;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Infrastructure.Persistence;

/// <summary>
/// Transactional job claim. Expired leases are recovered first; a GPU job is
/// only handed out when no other GPU job holds a live lease, which enforces the
/// single-GPU serialization rule at the queue boundary.
/// </summary>
public sealed class EfJobQueue(PrintSheetDbContext db, IClock clock) : IJobQueue
{
    private static readonly JobType[] WorkerTypes =
    [
        JobType.Classify,
        JobType.Trim,
        JobType.BackgroundRemoval,
        JobType.Upscale,
        JobType.Vectorize,
        JobType.Resize,
    ];

    public async Task<Job?> ClaimAsync(
        string workerId,
        IReadOnlyList<JobCapability> capabilities,
        int leaseSeconds,
        bool workerJobsOnly,
        CancellationToken cancellationToken)
    {
        var now = clock.UtcNow;
        await using var transaction = await db.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);

        // SQLite cannot translate DateTimeOffset comparisons and enum arrays,
        // so keep the database filter minimal and finish the selection in
        // memory. A print shop has tens of jobs, not millions.
        var running = await db.Jobs
            .Where(job => job.Status == JobStatus.Running)
            .ToListAsync(cancellationToken);

        var expired = running
            .Where(job => job.LeaseExpiresAt is { } expiresAt && expiresAt <= now)
            .ToList();
        foreach (var job in expired)
        {
            job.RecoverExpiredLease(now);
        }

        if (expired.Count > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        var gpuBusy = running.Any(job =>
            !expired.Contains(job)
            && job.Capability == JobCapability.Gpu
            && job.LeaseExpiresAt is { } expiresAt
            && expiresAt > now);

        var types = workerJobsOnly ? WorkerTypes : Enum.GetValues<JobType>();
        var queued = await db.Jobs
            .Where(job => job.Status == JobStatus.Queued)
            .ToListAsync(cancellationToken);

        var candidate = queued
            .Where(job =>
                types.Contains(job.Type)
                && capabilities.Contains(job.Capability)
                && (!gpuBusy || job.Capability != JobCapability.Gpu))
            .OrderBy(job => job.CreatedAt)
            .FirstOrDefault();

        if (candidate is null)
        {
            await transaction.CommitAsync(cancellationToken);
            return null;
        }

        var claimed = candidate.TryClaim(
            workerId,
            Guid.NewGuid().ToString("N"),
            leaseSeconds,
            now);
        if (!claimed.IsSuccess)
        {
            await transaction.RollbackAsync(cancellationToken);
            return null;
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return candidate;
    }
}
