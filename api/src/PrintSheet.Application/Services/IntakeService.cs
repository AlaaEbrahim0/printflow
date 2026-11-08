using System.Text.Json;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Common;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.Services;

public sealed class IntakeOptions
{
    public long MaxUploadBytes { get; init; } = 50L * 1024 * 1024;

    public int MaxDimensionPx { get; init; } = 30_000;

    public IReadOnlySet<string> AllowedFormats { get; init; } =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "png",
            "jpeg",
            "webp",
            "tiff",
        };
}

/// <summary>
/// The single HTTP endpoint that accepts file bytes. Stores the original
/// immutably and queues classification; never re-encodes customer pixels.
/// </summary>
public sealed class IntakeService
{
    private readonly IBatchRepository _batches;
    private readonly IJobRepository _jobs;
    private readonly IFileStore _files;
    private readonly IImageInspector _images;
    private readonly IClock _clock;
    private readonly IntakeOptions _options;

    public IntakeService(
        IBatchRepository batches,
        IJobRepository jobs,
        IFileStore files,
        IImageInspector images,
        IClock clock,
        IntakeOptions options)
    {
        _batches = batches;
        _jobs = jobs;
        _files = files;
        _images = images;
        _clock = clock;
        _options = options;
    }

    public async Task<Result<(Batch Batch, Design Design)>> UploadAsync(
        Guid batchId,
        UploadDesignCommand command,
        string actor,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(batchId, cancellationToken);
        if (batch is null)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.BatchNotFound,
                $"Batch {batchId} was not found.");
        }

        if (command.Length <= 0)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.UnsupportedImage,
                "The uploaded file is empty.");
        }

        if (command.Length > _options.MaxUploadBytes)
        {
            return Result<(Batch, Design)>.Failure(
                ErrorCodes.UploadTooLarge,
                $"The upload exceeds the {_options.MaxUploadBytes} byte limit.");
        }

        Stream source = command.File;
        MemoryStream? buffer = null;
        if (!source.CanSeek)
        {
            buffer = new MemoryStream();
            await source.CopyToAsync(buffer, cancellationToken);
            buffer.Position = 0;
            source = buffer;
        }

        try
        {
            ImageInspection inspection;
            try
            {
                inspection = await _images.InspectAsync(source, cancellationToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                return Result<(Batch, Design)>.Failure(
                    ErrorCodes.UnsupportedImage,
                    $"The file could not be decoded as an image: {exception.Message}");
            }

            var format = inspection.Format.TrimStart('.').ToLowerInvariant();
            if (!_options.AllowedFormats.Contains(format))
            {
                return Result<(Batch, Design)>.Failure(
                    ErrorCodes.UnsupportedImage,
                    $"Format '{inspection.Format}' is not accepted. Allowed: PNG, JPEG, WebP, TIFF.");
            }

            if (inspection.WidthPx > _options.MaxDimensionPx || inspection.HeightPx > _options.MaxDimensionPx)
            {
                return Result<(Batch, Design)>.Failure(
                    ErrorCodes.UnsupportedImage,
                    $"Images larger than {_options.MaxDimensionPx} px per side are not accepted.");
            }

            var garmentResult = GarmentColor.Create(command.GarmentColorKind, command.GarmentColorHex);
            if (!garmentResult.IsSuccess)
            {
                return Result<(Batch, Design)>.Failure(garmentResult.Error!);
            }

            var designId = Guid.NewGuid();
            var versionId = Guid.NewGuid();
            var extension = NormalizeExtension(inspection.FileExtension, format);
            var filePath = $"{batch.Id}/designs/{designId}/versions/{versionId}{extension}";

            source.Position = 0;
            await _files.WriteAsync(filePath, source, cancellationToken);

            var name = string.IsNullOrWhiteSpace(command.Name)
                ? Path.GetFileNameWithoutExtension(command.FileName)
                : command.Name.Trim();
            if (string.IsNullOrWhiteSpace(name))
            {
                name = "Design";
            }

            var parametersJson = JsonSerializer.Serialize(
                new
                {
                    source = "upload",
                    originalFileName = command.FileName,
                    format,
                    sizeBytes = command.Length,
                },
                ApplicationJson.Options);

            var versionResult = DesignVersion.CreateOriginal(
                versionId,
                designId,
                filePath,
                inspection.WidthPx,
                inspection.HeightPx,
                inspection.HasAlpha,
                parametersJson,
                _clock.UtcNow);

            if (!versionResult.IsSuccess)
            {
                return Result<(Batch, Design)>.Failure(versionResult.Error!);
            }

            var designResult = Design.Create(
                designId,
                batch.Id,
                name,
                garmentResult.Value!,
                allowRotation: true,
                command.TargetWidthCm,
                command.TargetHeightCm,
                notes: null,
                versionResult.Value!,
                batch.Geometry.WorkingDpi,
                _clock.UtcNow);

            if (!designResult.IsSuccess)
            {
                return Result<(Batch, Design)>.Failure(designResult.Error!);
            }

            var design = designResult.Value!;
            var added = batch.AddDesign(design, actor, _clock.UtcNow);
            if (!added.IsSuccess)
            {
                return Result<(Batch, Design)>.Failure(added.Error!);
            }

            var classifyContext = new
            {
                workingDpi = batch.Geometry.WorkingDpi,
                targetWidthCm = design.TargetWidthCm,
                targetHeightCm = design.TargetHeightCm,
                sourceVersionId = versionId,
                originalPath = filePath,
                garmentColor = new
                {
                    kind = design.GarmentColor.Kind.ToContract(),
                    hex = design.GarmentColor.Hex,
                },
            };

            var classifyParameters = new
            {
                targetWidthCm = design.TargetWidthCm,
                targetHeightCm = design.TargetHeightCm,
            };

            var jobResult = Job.Create(
                Guid.NewGuid(),
                batch.Id,
                design.Id,
                JobType.Classify,
                JobCapability.Image,
                JsonSerializer.Serialize(classifyParameters, ApplicationJson.Options),
                JsonSerializer.Serialize(classifyContext, ApplicationJson.Options),
                filePath,
                outputPath: null,
                inputArtifactsJson: "{}",
                outputArtifactsJson: "{}",
                Job.DefaultMaxAttempts,
                _clock.UtcNow);

            if (!jobResult.IsSuccess)
            {
                return Result<(Batch, Design)>.Failure(jobResult.Error!);
            }

            _jobs.Add(jobResult.Value!);
            await _batches.SaveChangesAsync(cancellationToken);
            return Result<(Batch, Design)>.Success((batch, design));
        }
        finally
        {
            if (buffer is not null)
            {
                await buffer.DisposeAsync();
            }
        }
    }

    private static string NormalizeExtension(string extension, string format)
    {
        var normalized = extension.Trim().ToLowerInvariant();
        if (normalized is ".png" or ".jpg" or ".jpeg" or ".webp" or ".tif" or ".tiff")
        {
            return normalized;
        }

        return format switch
        {
            "png" => ".png",
            "jpeg" => ".jpg",
            "webp" => ".webp",
            "tiff" => ".tif",
            _ => ".png",
        };
    }
}
