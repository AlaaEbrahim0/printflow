using Microsoft.EntityFrameworkCore;
using PrintSheet.Application.Abstractions;
using PrintSheet.Domain.Batches;

namespace PrintSheet.Infrastructure.Persistence;

/// <summary>EF-backed batch aggregate repository. One aggregate per request scope.</summary>
public sealed class EfBatchRepository(PrintSheetDbContext db) : IBatchRepository
{
    public Task<Batch?> FindAsync(Guid batchId, CancellationToken cancellationToken)
        => FullGraph().FirstOrDefaultAsync(batch => batch.Id == batchId, cancellationToken);

    public Task<Batch?> FindByDesignAsync(Guid designId, CancellationToken cancellationToken)
        => FullGraph()
            .FirstOrDefaultAsync(
                batch => batch.Designs.Any(design => design.Id == designId),
                cancellationToken);

    public Task<Batch?> FindByExportAsync(Guid exportId, CancellationToken cancellationToken)
        => FullGraph()
            .FirstOrDefaultAsync(
                batch => batch.Exports.Any(export => export.Id == exportId),
                cancellationToken);

    public async Task<(IReadOnlyList<Batch> Items, int Total)> ListAsync(
        BatchStatus? status,
        int limit,
        int offset,
        CancellationToken cancellationToken)
    {
        var query = db.Batches.AsNoTracking();
        if (status is not null)
        {
            query = query.Where(batch => batch.Status == status);
        }

        var total = await query.CountAsync(cancellationToken);
        // SQLite cannot ORDER BY DateTimeOffset; sort the small list in memory.
        var items = (await query
                .Include(batch => batch.Designs)
                .Include(batch => batch.Sheets)
                .ToListAsync(cancellationToken))
            .OrderByDescending(batch => batch.UpdatedAt)
            .Skip(offset)
            .Take(limit)
            .ToList();

        return (items, total);
    }

    public void Add(Batch batch) => db.Batches.Add(batch);

    public Task SaveChangesAsync(CancellationToken cancellationToken)
        => db.SaveChangesAsync(cancellationToken);

    private IQueryable<Batch> FullGraph()
        => db.Batches
            .Include(batch => batch.Designs)
            .ThenInclude(design => design.Versions)
            .Include(batch => batch.Sheets)
            .Include(batch => batch.Exports)
            .Include(batch => batch.AuditEntries);
}
