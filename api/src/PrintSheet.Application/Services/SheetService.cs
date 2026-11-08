using System.Text.Json;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Common;
using PrintSheet.Application.Jobs;
using PrintSheet.Application.Settings;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;
using PrintSheet.Domain.Units;

namespace PrintSheet.Application.Services;

public sealed class SheetService
{
    private readonly IBatchRepository _batches;
    private readonly IJobRepository _jobs;
    private readonly IFileStore _files;
    private readonly IAppSettingsStore _settings;
    private readonly IClock _clock;

    public SheetService(
        IBatchRepository batches,
        IJobRepository jobs,
        IFileStore files,
        IAppSettingsStore settings,
        IClock clock)
    {
        _batches = batches;
        _jobs = jobs;
        _files = files;
        _settings = settings;
        _clock = clock;
    }

    public async Task<Result<Batch>> GetBatchAsync(Guid batchId, CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        return batch is null
            ? Result<Batch>.Failure(ErrorCodes.BatchNotFound, $"Batch {batchId} was not found.")
            : Result<Batch>.Success(batch);
    }

    public async Task<Result<Sheet>> GetCurrentSheetAsync(
        Guid batchId,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<Sheet>.Failure(ErrorCodes.BatchNotFound, $"Batch {batchId} was not found.");
        }

        return batch.CurrentSheet is { } sheet
            ? Result<Sheet>.Success(sheet)
            : Result<Sheet>.Failure(ErrorCodes.SheetNotFound, "The batch has no sheet yet.");
    }

    public async Task<Result<ArtifactFile>> OpenPreviewAsync(
        Guid batchId,
        CancellationToken cancellationToken)
    {
        var sheetResult = await GetCurrentSheetAsync(batchId, cancellationToken);
        if (!sheetResult.IsSuccess)
        {
            return Result<ArtifactFile>.Failure(sheetResult.Error!);
        }

        var sheet = sheetResult.Value!;
        if (string.IsNullOrWhiteSpace(sheet.PreviewPath)
            || !await _files.ExistsAsync(sheet.PreviewPath, cancellationToken))
        {
            return Result<ArtifactFile>.Failure(
                ErrorCodes.SheetNotFound,
                "The current sheet has no preview yet.");
        }

        var stream = await _files.OpenReadAsync(sheet.PreviewPath, cancellationToken);
        return Result<ArtifactFile>.Success(
            new ArtifactFile(stream, "image/png", $"sheet-{sheet.Revision}-preview.png"));
    }

    public async Task<Result<JobAccepted>> PackAsync(
        Guid batchId,
        PackSheetCommand command,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.BatchNotFound,
                $"Batch {batchId} was not found.");
        }

        var included = batch.IncludedDesigns;
        if (included.Count == 0)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.BatchHasNoDesigns,
                "The batch has no included designs to pack.");
        }

        var unfinished = included
            .Where(design => design.Status != DesignStatus.Ready)
            .Select(design => new { id = design.Id, name = design.Name, status = design.Status.ToContract() })
            .ToArray();

        if (unfinished.Length > 0)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.BatchNotReady,
                "Every included design must be ready before packing.",
                new Dictionary<string, object?> { ["designs"] = unfinished });
        }

        var selected = included;
        if (command.DesignIds is not null)
        {
            if (command.DesignIds.Count == 0
                || command.DesignIds.Distinct().Count() != command.DesignIds.Count)
            {
                return Invalid("Select at least one unique design to pack.");
            }

            var includedById = included.ToDictionary(design => design.Id);
            if (command.DesignIds.Any(designId => !includedById.ContainsKey(designId)))
            {
                return Invalid("Every selected design must be included in this batch.");
            }

            selected = command.DesignIds.Select(designId => includedById[designId]).ToArray();
        }

        if (await _jobs.HasActiveJobAsync(batch.Id, JobType.PackSheet, null, cancellationToken))
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.JobInFlight,
                "A pack job is already queued or running for this batch.");
        }

        var settings = await _settings.GetAsync(cancellationToken);
        var packer = settings.Packer;

        var randomizedOrderings = command.RandomizedOrderings ?? packer.RandomizedOrderings;
        var timeBudgetMs = command.TimeBudgetMs ?? packer.TimeBudgetMs;
        var alphaThreshold = command.AlphaThreshold ?? packer.AlphaThreshold;
        var cellMm = command.CellMm ?? packer.CellMm;

        if (randomizedOrderings is < 1 or > 1000)
        {
            return Invalid("Randomized ordering count must be between 1 and 1000.");
        }

        if (timeBudgetMs is < 1000 or > 600000)
        {
            return Invalid("Packer time budget must be between 1000 and 600000 ms.");
        }

        if (alphaThreshold is < 0 or > 254)
        {
            return Invalid("Alpha threshold must be between 0 and 254.");
        }

        if (cellMm is < 0.1m or > 50m)
        {
            return Invalid("Occupancy cell size must be between 0.1 and 50 mm.");
        }

        var jobId = Guid.NewGuid();
        var sheetId = Guid.NewGuid();
        var revision = batch.CurrentRevision + 1;
        var directory = $"{batch.Id}/sheets/{sheetId}/{revision}";
        var previewPath = $"{directory}/preview.png";
        var manifestPath = $"{directory}/placements.json";
        var seed = command.Seed ?? Random.Shared.Next();

        var designs = selected.Select(design =>
        {
            var version = design.CurrentVersion!;
            return new
            {
                designId = design.Id,
                versionId = version.Id,
                displayName = design.Name,
                filePath = version.FilePath,
                widthPx = version.WidthPx,
                heightPx = version.HeightPx,
                allowRotation = design.AllowRotation,
                targetWidthCm = design.TargetWidthCm,
                targetHeightCm = design.TargetHeightCm,
            };
        }).ToArray();

        var request = new
        {
            schemaVersion = "1.0",
            requestId = jobId.ToString(),
            rollWidthCm = batch.Geometry.RollWidthCm,
            marginMm = batch.Geometry.MarginMm,
            edgeMarginMm = batch.Geometry.EdgeMarginMm,
            dpi = batch.Geometry.WorkingDpi,
            alphaThreshold,
            cellMm,
            randomizedOrderings,
            timeBudgetMs,
            seed,
            noInterlocking = command.NoInterlocking,
            designs,
            output = new
            {
                directory,
                previewPath,
                manifestPath,
            },
        };

        var snapshot = new
        {
            sheetId,
            revision,
            dpi = batch.Geometry.WorkingDpi,
            requestedDesignIds = selected.Select(design => design.Id).ToArray(),
            designs = included.Select(design => new
            {
                designId = design.Id,
                versionId = design.CurrentVersionId,
            }).ToArray(),
        };

        var jobResult = Job.Create(
            jobId,
            batch.Id,
            designId: null,
            JobType.PackSheet,
            JobCapability.Packer,
            JsonSerializer.Serialize(request, ApplicationJson.Options),
            JsonSerializer.Serialize(snapshot, ApplicationJson.Options),
            inputPath: null,
            outputPath: manifestPath,
            inputArtifactsJson: "{}",
            outputArtifactsJson: JsonSerializer.Serialize(
                new Dictionary<string, string>
                {
                    ["preview"] = previewPath,
                    ["manifest"] = manifestPath,
                },
                ApplicationJson.Web),
            Job.DefaultMaxAttempts,
            _clock.UtcNow);

        if (!jobResult.IsSuccess)
        {
            return Result<JobAccepted>.Failure(jobResult.Error!);
        }

        _jobs.Add(jobResult.Value!);
        batch.RecordAudit("sheet-pack-queued", "operator", null, null, null, null, _clock.UtcNow);
        batch.Touch(_clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<JobAccepted>.Success(new JobAccepted(jobId, JobStatus.Queued));
    }

    public async Task<Result<Sheet>> UpdatePlacementsAsync(
        Guid batchId,
        int revision,
        IReadOnlyList<ManualPlacementCommand> manualPlacements,
        string actor,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<Sheet>.Failure(ErrorCodes.BatchNotFound, $"Batch {batchId} was not found.");
        }

        var sheet = batch.CurrentSheet;
        if (sheet is null)
        {
            return Result<Sheet>.Failure(ErrorCodes.SheetNotFound, "The batch has no sheet yet.");
        }

        if (sheet.Revision != revision)
        {
            return Result<Sheet>.Failure(
                ErrorCodes.StaleRevision,
                $"The sheet is at revision {sheet.Revision}, not {revision}.");
        }

        if (sheet.Stale)
        {
            return Result<Sheet>.Failure(
                ErrorCodes.SheetStale,
                "The sheet is stale after an upstream change; repack before editing placements.");
        }

        var seen = new HashSet<Guid>();
        var placements = new List<Placement>(manualPlacements.Count);
        foreach (var manual in manualPlacements)
        {
            if (!seen.Add(manual.DesignId))
            {
                return Result<Sheet>.Failure(
                    ErrorCodes.InvalidRequest,
                    $"Design {manual.DesignId} appears more than once.");
            }

            var design = batch.FindDesign(manual.DesignId);
            if (design is null)
            {
                return Result<Sheet>.Failure(
                    ErrorCodes.DesignNotFound,
                    $"Design {manual.DesignId} was not found.");
            }

            if (design.Status != DesignStatus.Ready)
            {
                return Result<Sheet>.Failure(
                    ErrorCodes.DesignNotReady,
                    $"Design {design.Name} is {design.Status.ToContract()} and cannot be placed.");
            }

            if (design.CurrentVersionId != manual.VersionId)
            {
                return Result<Sheet>.Failure(
                    ErrorCodes.StaleSource,
                    $"Design {design.Name} does not have version {manual.VersionId} as current.");
            }

            var version = design.CurrentVersion!;
            var rotated = manual.RotationDeg is 90 or 270;
            var widthPx = rotated ? version.HeightPx : version.WidthPx;
            var heightPx = rotated ? version.WidthPx : version.HeightPx;

            var placementResult = Placement.Create(
                design.Id,
                version.Id,
                design.Name,
                manual.XCm,
                manual.YCm,
                PrintUnits.CentimetersForPixels(widthPx, sheet.Dpi),
                PrintUnits.CentimetersForPixels(heightPx, sheet.Dpi),
                widthPx,
                heightPx,
                manual.RotationDeg);

            if (!placementResult.IsSuccess)
            {
                return Result<Sheet>.Failure(placementResult.Error!);
            }

            placements.Add(placementResult.Value!);
        }

        var applied = sheet.ApplyManualPlacements(placements, _clock.UtcNow);
        if (!applied.IsSuccess)
        {
            return Result<Sheet>.Failure(applied.Error!);
        }

        batch.Touch(_clock.UtcNow);
        batch.RecordAudit("sheet-placements-updated", actor, null, null, null, null, _clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<Sheet>.Success(sheet);
    }

    public async Task<Result<JobAccepted>> RunIntegrityCheckAsync(
        Guid batchId,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.BatchNotFound,
                $"Batch {batchId} was not found.");
        }

        var sheet = batch.CurrentSheet;
        if (sheet is null)
        {
            return Result<JobAccepted>.Failure(ErrorCodes.SheetNotFound, "The batch has no sheet yet.");
        }

        if (sheet.Stale)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.SheetStale,
                "The sheet is stale after an upstream change; repack before checking integrity.");
        }

        if (string.IsNullOrWhiteSpace(sheet.ManifestPath))
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.SheetNotFound,
                "The sheet has no placements manifest yet.");
        }

        if (await _jobs.HasActiveJobAsync(batch.Id, JobType.IntegrityCheck, null, cancellationToken))
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.JobInFlight,
                "An integrity check is already queued or running for this sheet.");
        }

        var jobId = Guid.NewGuid();
        var parameters = new
        {
            manifestPath = sheet.ManifestPath,
        };
        var context = new
        {
            sheetId = sheet.Id,
            revision = sheet.Revision,
        };

        var jobResult = Job.Create(
            jobId,
            batch.Id,
            designId: null,
            JobType.IntegrityCheck,
            JobCapability.Packer,
            JsonSerializer.Serialize(parameters, ApplicationJson.Options),
            JsonSerializer.Serialize(context, ApplicationJson.Options),
            inputPath: sheet.ManifestPath,
            outputPath: null,
            inputArtifactsJson: "{}",
            outputArtifactsJson: "{}",
            Job.DefaultMaxAttempts,
            _clock.UtcNow);

        if (!jobResult.IsSuccess)
        {
            return Result<JobAccepted>.Failure(jobResult.Error!);
        }

        _jobs.Add(jobResult.Value!);
        batch.RecordAudit("integrity-check-queued", "operator", null, null, null, null, _clock.UtcNow);
        batch.Touch(_clock.UtcNow);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<JobAccepted>.Success(new JobAccepted(jobId, JobStatus.Queued));
    }

    private static Result<JobAccepted> Invalid(string message)
        => Result<JobAccepted>.Failure(ErrorCodes.InvalidRequest, message);
}
