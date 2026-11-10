using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Batches;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Application.Services;

public sealed class BatchService
{
    private readonly IBatchRepository _batches;
    private readonly IAppSettingsStore _settings;
    private readonly IClock _clock;
    private readonly IFileStore _files;
    private readonly IJobRepository _jobs;

    public BatchService(
        IBatchRepository batches,
        IAppSettingsStore settings,
        IClock clock,
        IFileStore files,
        IJobRepository jobs)
    {
        _batches = batches;
        _settings = settings;
        _clock = clock;
        _files = files;
        _jobs = jobs;
    }

    public async Task<(IReadOnlyList<Batch> Items, int Total)> ListAsync(
        BatchStatus? status,
        int limit,
        int offset,
        CancellationToken cancellationToken)
    {
        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(0, offset);
        return await _batches.ListAsync(status, limit, offset, cancellationToken);
    }

    public Task<Batch?> GetAsync(Guid batchId, CancellationToken cancellationToken)
        => _batches.FindAsync(batchId, cancellationToken);

    public async Task<Result<Batch>> CreateAsync(
        CreateBatchCommand command,
        CancellationToken cancellationToken)
    {
        var settings = await _settings.GetAsync(cancellationToken);
        var geometryResult = BatchGeometry.Create(
            command.RollWidthCm ?? settings.DefaultRollWidthCm,
            command.MarginMm ?? settings.DefaultMarginMm,
            command.EdgeMarginMm ?? settings.DefaultEdgeMarginMm,
            command.WorkingDpi ?? settings.WorkingDpi);

        if (!geometryResult.IsSuccess)
        {
            return Result<Batch>.Failure(geometryResult.Error!);
        }

        var batchResult = Batch.Create(
            Guid.NewGuid(),
            command.Name,
            geometryResult.Value!,
            _clock.UtcNow);

        if (!batchResult.IsSuccess)
        {
            return batchResult;
        }

        _batches.Add(batchResult.Value!);
        await _batches.SaveChangesAsync(cancellationToken);
        return batchResult;
    }

    public async Task<Result<Batch>> UpdateAsync(
        Guid batchId,
        UpdateBatchCommand command,
        string actor,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<Batch>.Failure(ErrorCodes.BatchNotFound, $"Batch {batchId} was not found.");
        }

        BatchGeometry? geometry = null;
        if (command.RollWidthCm is not null
            || command.MarginMm is not null
            || command.EdgeMarginMm is not null)
        {
            var geometryResult = BatchGeometry.Create(
                command.RollWidthCm ?? batch.Geometry.RollWidthCm,
                command.MarginMm ?? batch.Geometry.MarginMm,
                command.EdgeMarginMm ?? batch.Geometry.EdgeMarginMm,
                batch.Geometry.WorkingDpi);

            if (!geometryResult.IsSuccess)
            {
                return Result<Batch>.Failure(geometryResult.Error!);
            }

            geometry = geometryResult.Value;
        }

        var update = batch.Update(command.Name, geometry, actor, _clock.UtcNow);
        if (!update.IsSuccess)
        {
            return Result<Batch>.Failure(update.Error!);
        }

        await _batches.SaveChangesAsync(cancellationToken);
        return Result<Batch>.Success(batch);
    }

    /// <summary>
    /// Deletes the entire batch and every file on disk for it. The batch's
    /// designs, versions, sheets, exports and audits go with it (EF cascade);
    /// the jobs table rows are removed separately. Active (queued or running)
    /// jobs are a hard block — the worker would lose its input files.
    /// </summary>
    public async Task<Result<Batch>> DeleteBatchAsync(
        Guid batchId,
        string actor,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<Batch>.Failure(
                ErrorCodes.BatchNotFound,
                $"Batch {batchId} was not found.");
        }

        if (await _jobs.HasAnyActiveJobAsync(batchId, cancellationToken))
        {
            return Result<Batch>.Failure(
                ErrorCodes.BatchInUse,
                $"Batch {batchId} still has active jobs. Cancel them before deleting the batch.");
        }

        // One operation deletes the whole directory tree for this batch:
        // image versions, masks, SVGs, job artifacts, export artifacts, sheets.
        await _files.DeleteDirectoryAsync(batchId.ToString(), cancellationToken);

        // Remove the jobs rows (a separate table — no cascade from the batch).
        await _jobs.DeleteByBatchAsync(batchId, cancellationToken);

        // Remove the aggregate; EF cascades to designs, versions, sheets,
        // exports and audit entries.
        await _batches.DeleteAsync(batch, cancellationToken);
        await _batches.SaveChangesAsync(cancellationToken);

        return Result<Batch>.Success(batch);
    }
}
