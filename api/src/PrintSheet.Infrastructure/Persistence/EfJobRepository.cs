using Microsoft.EntityFrameworkCore;
using PrintSheet.Application.Abstractions;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Infrastructure.Persistence;

/// <summary>EF-backed jobs table used by the API and the worker lease protocol.</summary>
public sealed class EfJobRepository(PrintSheetDbContext db) : IJobRepository
{
    public Task<Job?> FindAsync(Guid jobId, CancellationToken cancellationToken)
        => db.Jobs.FirstOrDefaultAsync(job => job.Id == jobId, cancellationToken);

    public Task<(IReadOnlyList<Job> Items, int Total)> ListByBatchAsync(
        Guid batchId,
        JobStatus? status,
        JobType? type,
        int limit,
        CancellationToken cancellationToken)
        => ListAsync(batchId, status, type, limit, cancellationToken);

    public Task<(IReadOnlyList<Job> Items, int Total)> ListAllAsync(
        JobStatus? status,
        JobType? type,
        int limit,
        CancellationToken cancellationToken)
        => ListAsync(null, status, type, limit, cancellationToken);

    private async Task<(IReadOnlyList<Job> Items, int Total)> ListAsync(
        Guid? batchId,
        JobStatus? status,
        JobType? type,
        int limit,
        CancellationToken cancellationToken)
    {
        var query = db.Jobs.AsNoTracking();
        if (batchId is not null)
        {
            query = query.Where(job => job.BatchId == batchId);
        }

        if (status is not null)
        {
            query = query.Where(job => job.Status == status);
        }

        if (type is not null)
        {
            query = query.Where(job => job.Type == type);
        }

        var total = await query.CountAsync(cancellationToken);
        // SQLite cannot ORDER BY DateTimeOffset; order the small page in memory.
        var items = (await query.ToListAsync(cancellationToken))
            .OrderByDescending(job => job.CreatedAt)
            .Take(limit)
            .ToList();
        return (items, total);
    }

    public Task<bool> HasActiveJobAsync(
        Guid batchId,
        JobType type,
        Guid? designId,
        CancellationToken cancellationToken)
        => db.Jobs.AnyAsync(
            job => job.BatchId == batchId
                   && job.Type == type
                   && job.DesignId == designId
                   && (job.Status == JobStatus.Queued || job.Status == JobStatus.Running),
            cancellationToken);

    public Task<bool> HasActiveStepJobAsync(Guid designId, CancellationToken cancellationToken)
        => db.Jobs.AnyAsync(
            job => job.DesignId == designId
                   && (job.Status == JobStatus.Queued || job.Status == JobStatus.Running)
                   && (job.Type == JobType.Trim
                       || job.Type == JobType.BackgroundRemoval
                       || job.Type == JobType.Upscale
                       || job.Type == JobType.Vectorize
                       || job.Type == JobType.Resize),
            cancellationToken);

    public Task<bool> HasAnyActiveJobAsync(Guid batchId, CancellationToken cancellationToken)
        => db.Jobs.AnyAsync(
            job => job.BatchId == batchId
                   && (job.Status == JobStatus.Queued || job.Status == JobStatus.Running),
            cancellationToken);

    public Task DeleteByBatchAsync(Guid batchId, CancellationToken cancellationToken)
    {
        var jobs = db.Jobs.Where(job => job.BatchId == batchId).ToList();
        db.Jobs.RemoveRange(jobs);
        return db.SaveChangesAsync(cancellationToken);
    }

    public void Add(Job job) => db.Jobs.Add(job);

    public Task SaveChangesAsync(CancellationToken cancellationToken)
        => db.SaveChangesAsync(cancellationToken);
}
