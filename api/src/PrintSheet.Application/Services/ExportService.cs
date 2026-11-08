using System.Text.Json;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Common;
using PrintSheet.Application.Jobs;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.Services;

public sealed class ExportService
{
    private readonly IBatchRepository _batches;
    private readonly IJobRepository _jobs;
    private readonly IFileStore _files;
    private readonly IClock _clock;

    public ExportService(
        IBatchRepository batches,
        IJobRepository jobs,
        IFileStore files,
        IClock clock)
    {
        _batches = batches;
        _jobs = jobs;
        _files = files;
        _clock = clock;
    }

    public async Task<Result<IReadOnlyList<ExportRecord>>> ListAsync(
        Guid batchId,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<IReadOnlyList<ExportRecord>>.Failure(
                ErrorCodes.BatchNotFound,
                $"Batch {batchId} was not found.");
        }

        return Result<IReadOnlyList<ExportRecord>>.Success(
            batch.Exports.OrderByDescending(export => export.CreatedAt).ToList());
    }

    public async Task<Result<ExportRecord>> GetAsync(
        Guid exportId,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindByExportAsync(exportId, cancellationToken);
        var export = batch?.FindExport(exportId);
        return export is null
            ? Result<ExportRecord>.Failure(
                ErrorCodes.ExportNotFound,
                $"Export {exportId} was not found.")
            : Result<ExportRecord>.Success(export);
    }

    public async Task<Result<JobAccepted>> CreateAsync(
        Guid batchId,
        CreateExportCommand command,
        string actor,
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
                "The sheet is stale after an upstream change; repack before exporting.");
        }

        if (sheet.State != SheetState.Valid || !sheet.IntegrityPassed || sheet.IntegrityReportJson is null)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.SheetIntegrityFailed,
                "Export requires a passed integrity report for the current sheet revision.");
        }

        if (command.Format is ExportFormat.LayeredPsd or ExportFormat.LayeredPsb)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.ExportFormatUnavailable,
                "Layered PSD/PSB export is not available yet. Use psd-bundle for a lossless rebuild bundle.");
        }

        if (string.IsNullOrWhiteSpace(sheet.ManifestPath))
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.SheetNotFound,
                "The current sheet has no placements manifest.");
        }

        var exportId = Guid.NewGuid();
        var exportResult = ExportRecord.CreateQueued(
            exportId,
            batch.Id,
            sheet.Id,
            sheet.Revision,
            command.Format,
            sheet.Dpi,
            sheet.IntegrityReportJson,
            _clock.UtcNow);

        if (!exportResult.IsSuccess)
        {
            return Result<JobAccepted>.Failure(exportResult.Error!);
        }

        var jobId = Guid.NewGuid();
        var outputDirectory = $"{batch.Id}/exports/{exportId}";
        var parameters = new
        {
            format = command.Format.ToContract(),
            manifestPath = sheet.ManifestPath,
            outputDirectory,
            includePreview = command.IncludePreview,
        };
        var context = new
        {
            exportId,
            sheetId = sheet.Id,
            revision = sheet.Revision,
            dpi = sheet.Dpi,
        };

        var jobResult = Job.Create(
            jobId,
            batch.Id,
            designId: null,
            JobType.Export,
            JobCapability.Export,
            JsonSerializer.Serialize(parameters, ApplicationJson.Options),
            JsonSerializer.Serialize(context, ApplicationJson.Options),
            inputPath: sheet.ManifestPath,
            outputPath: outputDirectory,
            inputArtifactsJson: "{}",
            outputArtifactsJson: "{}",
            Job.DefaultMaxAttempts,
            _clock.UtcNow);

        if (!jobResult.IsSuccess)
        {
            return Result<JobAccepted>.Failure(jobResult.Error!);
        }

        var added = batch.AddExport(exportResult.Value!, actor, _clock.UtcNow);
        if (!added.IsSuccess)
        {
            return Result<JobAccepted>.Failure(added.Error!);
        }

        _jobs.Add(jobResult.Value!);
        await _batches.SaveChangesAsync(cancellationToken);
        return Result<JobAccepted>.Success(new JobAccepted(jobId, JobStatus.Queued));
    }

    public async Task<Result<ArtifactFile>> OpenArtifactAsync(
        Guid exportId,
        string artifactName,
        CancellationToken cancellationToken)
    {
        if (!ExportArtifactNameExtensions.TryParseContract(artifactName, out var name))
        {
            return Result<ArtifactFile>.Failure(
                ErrorCodes.ExportNotFound,
                $"Unknown export artifact '{artifactName}'.");
        }

        var batch = await _batches.FindByExportAsync(exportId, cancellationToken);
        var export = batch?.FindExport(exportId);
        if (export is null)
        {
            return Result<ArtifactFile>.Failure(
                ErrorCodes.ExportNotFound,
                $"Export {exportId} was not found.");
        }

        var artifact = export.Artifacts.FirstOrDefault(candidate => candidate.Name == name);
        if (artifact is null)
        {
            return Result<ArtifactFile>.Failure(
                ErrorCodes.ExportNotFound,
                $"Export {exportId} has no '{artifactName}' artifact.");
        }

        if (!await _files.ExistsAsync(artifact.StoragePath, cancellationToken))
        {
            return Result<ArtifactFile>.Failure(
                ErrorCodes.ExportNotFound,
                "The export artifact is missing from storage.");
        }

        var stream = await _files.OpenReadAsync(artifact.StoragePath, cancellationToken);
        var extension = Path.GetExtension(artifact.StoragePath);
        return Result<ArtifactFile>.Success(new ArtifactFile(
            stream,
            artifact.ContentType,
            $"{exportId}-{artifact.Name.ToContract()}{extension}"));
    }
}
