using PrintSheet.Domain.Batches;

namespace PrintSheet.Application.Abstractions;

/// <summary>Persistence port for the batch aggregate. Implemented with EF Core.</summary>
public interface IBatchRepository
{
    Task<Batch?> FindAsync(Guid batchId, CancellationToken cancellationToken);

    Task<Batch?> FindByDesignAsync(Guid designId, CancellationToken cancellationToken);

    Task<Batch?> FindByExportAsync(Guid exportId, CancellationToken cancellationToken);

    Task<(IReadOnlyList<Batch> Items, int Total)> ListAsync(
        BatchStatus? status,
        int limit,
        int offset,
        CancellationToken cancellationToken);

    /// <summary>Deletes the aggregate and cascades to designs, versions, sheets, exports and audits.</summary>
    Task DeleteAsync(Batch batch, CancellationToken cancellationToken);

    void Add(Batch batch);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}
