using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Jobs;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Application.Services;

public sealed class DesignService
{
    private readonly IBatchRepository _batches;
    private readonly IFileStore _files;
    private readonly IClock _clock;

    public DesignService(IBatchRepository batches, IFileStore files, IClock clock)
    {
        _batches = batches;
        _files = files;
        _clock = clock;
    }

    public async Task<(Batch Batch, Design Design)?> FindAsync(
        Guid designId,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindByDesignAsync(designId, cancellationToken);
        var design = batch?.FindDesign(designId);
        return design is null ? null : (batch!, design);
    }

    public async Task<Result<(Batch Batch, Design Design)>> GetAsync(
        Guid designId,
        CancellationToken cancellationToken)
    {
        var found = await FindAsync(designId, cancellationToken);
        return found is null
            ? Result<(Batch, Design)>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.")
            : Result<(Batch, Design)>.Success(found.Value);
    }

    public async Task<Result<(Batch Batch, Design Design)>> UpdateAsync(
        Guid designId,
        UpdateDesignCommand command,
        string actor,
        CancellationToken cancellationToken)
    {
        var found = await FindAsync(designId, cancellationToken);
        if (found is null)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        var (batch, design) = found.Value;
        var previousWidth = design.TargetWidthCm;
        var previousHeight = design.TargetHeightCm;
        var previousRotation = design.AllowRotation;

        var update = design.UpdateMetadata(
            command.Name,
            command.GarmentColor,
            command.AllowRotation,
            command.TargetWidthCm,
            command.TargetHeightCm,
            command.Notes,
            _clock.UtcNow);

        if (!update.IsSuccess)
        {
            return Result<(Batch, Design)>.Failure(update.Error!);
        }

        var packingChanged = previousWidth != design.TargetWidthCm
            || previousHeight != design.TargetHeightCm
            || previousRotation != design.AllowRotation;

        if (packingChanged)
        {
            batch.InvalidateSheet(_clock.UtcNow);
        }
        else
        {
            batch.Touch(_clock.UtcNow);
        }

        batch.RecordAudit("design-updated", actor, null, design.Id, null, null, _clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<(Batch, Design)>.Success((batch, design));
    }

    public Task<Result> ExcludeAsync(
        Guid designId,
        string actor,
        CancellationToken cancellationToken)
        => ChangeStatusAsync(designId, "design-excluded", actor, (design, at) => design.Exclude(at), cancellationToken);

    public Task<Result> IncludeAsync(
        Guid designId,
        string actor,
        CancellationToken cancellationToken)
        => ChangeStatusAsync(designId, "design-included", actor, (design, at) => design.Include(at), cancellationToken);

    public Task<Result> RequestBetterSourceAsync(
        Guid designId,
        string actor,
        CancellationToken cancellationToken)
        => ChangeStatusAsync(
            designId,
            "better-source-requested",
            actor,
            (design, at) => design.RequestBetterSource(at),
            cancellationToken);

    public Task<Result> ResumeAsync(
        Guid designId,
        string actor,
        CancellationToken cancellationToken)
        => ChangeStatusAsync(designId, "design-resumed", actor, (design, at) => design.Resume(at), cancellationToken);

    public async Task<Result<VersionFile>> OpenVersionFileAsync(
        Guid designId,
        Guid versionId,
        CancellationToken cancellationToken)
    {
        var found = await FindAsync(designId, cancellationToken);
        if (found is null)
        {
            return Result<VersionFile>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        var version = found.Value.Design.FindVersion(versionId);
        if (version is null)
        {
            return Result<VersionFile>.Failure(
                ErrorCodes.VersionNotFound,
                $"Version {versionId} was not found.");
        }

        if (!await _files.ExistsAsync(version.FilePath, cancellationToken))
        {
            return Result<VersionFile>.Failure(
                ErrorCodes.VersionNotFound,
                "The version file is missing from storage.");
        }

        var stream = await _files.OpenReadAsync(version.FilePath, cancellationToken);
        var extension = Path.GetExtension(version.FilePath).ToLowerInvariant();
        return Result<VersionFile>.Success(new VersionFile(
            stream,
            ContentTypeFor(extension),
            $"{version.Id}{extension}"));
    }

    /// <summary>
    /// Opens a mask or SVG sidecar artifact. The frozen contract exposes
    /// maskUrl/svgUrl, so the API also serves those bytes here.
    /// </summary>
    public async Task<Result<VersionFile>> OpenArtifactAsync(
        Guid designId,
        Guid versionId,
        string artifact,
        CancellationToken cancellationToken)
    {
        var found = await FindAsync(designId, cancellationToken);
        if (found is null)
        {
            return Result<VersionFile>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        var version = found.Value.Design.FindVersion(versionId);
        if (version is null)
        {
            return Result<VersionFile>.Failure(
                ErrorCodes.VersionNotFound,
                $"Version {versionId} was not found.");
        }

        var (path, contentType, fallbackName) = artifact switch
        {
            "mask" => (version.MaskPath, "image/png", "mask.png"),
            "svg" => (version.SvgPath, "image/svg+xml", "vector.svg"),
            _ => (null, string.Empty, string.Empty),
        };

        if (path is null)
        {
            return Result<VersionFile>.Failure(
                ErrorCodes.VersionNotFound,
                $"Version {versionId} has no '{artifact}' artifact.");
        }

        if (!await _files.ExistsAsync(path, cancellationToken))
        {
            return Result<VersionFile>.Failure(
                ErrorCodes.VersionNotFound,
                $"The '{artifact}' artifact is missing from storage.");
        }

        var stream = await _files.OpenReadAsync(path, cancellationToken);
        return Result<VersionFile>.Success(new VersionFile(
            stream,
            contentType,
            $"{version.Id}-{fallbackName}"));
    }

    private async Task<Result> ChangeStatusAsync(
        Guid designId,
        string auditAction,
        string actor,
        Func<Design, DateTimeOffset, Result> change,
        CancellationToken cancellationToken)
    {
        var found = await FindAsync(designId, cancellationToken);
        if (found is null)
        {
            return Result.Failure(ErrorCodes.DesignNotFound, $"Design {designId} was not found.");
        }

        var (batch, design) = found.Value;
        var result = change(design, _clock.UtcNow);
        if (!result.IsSuccess)
        {
            return result;
        }

        batch.InvalidateSheet(_clock.UtcNow);
        batch.RecordAudit(auditAction, actor, null, design.Id, null, null, _clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }

    private static string ContentTypeFor(string extension) => extension switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".tif" or ".tiff" => "image/tiff",
        _ => "application/octet-stream",
    };
}
