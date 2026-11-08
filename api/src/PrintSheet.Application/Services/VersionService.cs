using PrintSheet.Application.Abstractions;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Application.Services;

public sealed class VersionService
{
    private readonly IBatchRepository _batches;
    private readonly IFileStore _files;
    private readonly IImageInspector _images;
    private readonly IClock _clock;

    public VersionService(
        IBatchRepository batches,
        IFileStore files,
        IImageInspector images,
        IClock clock)
    {
        _batches = batches;
        _files = files;
        _images = images;
        _clock = clock;
    }

    public async Task<Result<(Batch Batch, Design Design)>> ApproveAsync(
        Guid designId,
        Guid versionId,
        string actor,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindByDesignAsync(designId, cancellationToken);
        var design = batch?.FindDesign(designId);
        if (batch is null || design is null)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        var version = design.FindVersion(versionId);
        if (version is null)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.VersionNotFound,
                $"Version {versionId} was not found.");
        }

        if (version.Status == VersionStatus.Proposed)
        {
            if (!await _files.ExistsAsync(version.FilePath, cancellationToken))
            {
                return Result<(Batch, Design)>.Failure(
                    ErrorCodes.VersionNotFound,
                    "The proposal file is missing from storage.");
            }

            try
            {
                await using var stream = await _files.OpenReadAsync(version.FilePath, cancellationToken);
                var inspection = await _images.InspectAsync(stream, cancellationToken);
                if (inspection.WidthPx != version.WidthPx || inspection.HeightPx != version.HeightPx)
                {
                    return Result<(Batch, Design)>.Failure(
                        ErrorCodes.UnsupportedImage,
                        $"Version metadata says {version.WidthPx}x{version.HeightPx} px but the file is "
                        + $"{inspection.WidthPx}x{inspection.HeightPx} px.");
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                return Result<(Batch, Design)>.Failure(
                    ErrorCodes.UnsupportedImage,
                    $"The version file could not be decoded: {exception.Message}");
            }
        }

        var approve = design.ApproveVersion(versionId, _clock.UtcNow);
        if (!approve.IsSuccess)
        {
            return Result<(Batch, Design)>.Failure(approve.Error!);
        }

        batch.InvalidateSheet(_clock.UtcNow);
        batch.RecordAudit("version-approved", actor, null, design.Id, versionId, null, _clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<(Batch, Design)>.Success((batch, design));
    }

    public async Task<Result<(Batch Batch, Design Design)>> RejectAsync(
        Guid designId,
        Guid versionId,
        string? reason,
        string actor,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindByDesignAsync(designId, cancellationToken);
        var design = batch?.FindDesign(designId);
        if (batch is null || design is null)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        var reject = design.RejectVersion(versionId, reason, _clock.UtcNow);
        if (!reject.IsSuccess)
        {
            return Result<(Batch, Design)>.Failure(reject.Error!);
        }

        batch.Touch(_clock.UtcNow);
        batch.RecordAudit("version-rejected", actor, reason, design.Id, versionId, null, _clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<(Batch, Design)>.Success((batch, design));
    }

    public async Task<Result<(Batch Batch, Design Design)>> RevertAsync(
        Guid designId,
        Guid targetVersionId,
        string actor,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindByDesignAsync(designId, cancellationToken);
        var design = batch?.FindDesign(designId);
        if (batch is null || design is null)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        var revert = design.RevertTo(targetVersionId, _clock.UtcNow);
        if (!revert.IsSuccess)
        {
            return Result<(Batch, Design)>.Failure(revert.Error!);
        }

        batch.InvalidateSheet(_clock.UtcNow);
        batch.RecordAudit("version-reverted", actor, null, design.Id, targetVersionId, null, _clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<(Batch, Design)>.Success((batch, design));
    }
}
