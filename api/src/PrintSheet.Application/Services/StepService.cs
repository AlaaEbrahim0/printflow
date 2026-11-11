using System.Text.Json;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Common;
using PrintSheet.Application.Jobs;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;
using PrintSheet.Domain.Units;

namespace PrintSheet.Application.Services;

/// <summary>
/// Enqueues image-processing proposals. The job snapshots the parent version
/// and target size; the worker result becomes a proposed version later.
/// </summary>
public sealed class StepService
{
    private readonly IBatchRepository _batches;
    private readonly IJobRepository _jobs;
    private readonly IClock _clock;

    public StepService(
        IBatchRepository batches,
        IJobRepository jobs,
        IClock clock)
    {
        _batches = batches;
        _jobs = jobs;
        _clock = clock;
    }

    public Task<Result<JobAccepted>> ProposeTrimAsync(
        Guid designId,
        TrimStepCommand command,
        CancellationToken cancellationToken)
    {
        if (command.Mode is not ("auto" or "manual"))
        {
            return Task.FromResult(Invalid("Trim mode must be auto or manual."));
        }

        if (command.Mode == "manual" && command.CropRect is null)
        {
            return Task.FromResult(Invalid("A manual trim requires a crop rectangle."));
        }

        return EnqueueStepAsync(
            designId,
            JobType.Trim,
            command.Mode == "manual" ? StepType.Crop : StepType.Trim,
            command,
            JobCapability.Image,
            validateParent: parent =>
            {
                if (command.Mode != "manual" || command.CropRect is null)
                {
                    return null;
                }

                var within = command.CropRect.ValidateWithin(parent.WidthPx, parent.HeightPx);
                return within.IsSuccess ? null : within.Error;
            },
            cancellationToken);
    }

    public Task<Result<JobAccepted>> ProposeCropAsync(
        Guid designId,
        CropStepCommand command,
        CancellationToken cancellationToken)
    {
        var trim = new TrimStepCommand(
            Mode: "manual",
            PaddingPx: null,
            Tolerance: null,
            CropRect: command.Rect,
            BackgroundSample: null);

        return EnqueueStepAsync(
            designId,
            JobType.Trim,
            StepType.Crop,
            trim,
            JobCapability.Image,
            validateParent: parent =>
            {
                var within = command.Rect.ValidateWithin(parent.WidthPx, parent.HeightPx);
                return within.IsSuccess ? null : within.Error;
            },
            cancellationToken);
    }

    public Task<Result<JobAccepted>> ProposeUpscaleAsync(
        Guid designId,
        UpscaleStepCommand command,
        CancellationToken cancellationToken)
    {
        if (command.Model is not ("realesrgan-x4plus" or "realesrgan-x4plus-anime"))
        {
            return Task.FromResult(Invalid("Unknown upscale model."));
        }

        if (command.Scale is not (2 or 4))
        {
            return Task.FromResult(Invalid("Upscale scale must be 2 or 4."));
        }

        return EnqueueStepAsync(
            designId,
            JobType.Upscale,
            StepType.Upscale,
            command,
            JobCapability.Gpu,
            validateParent: null,
            cancellationToken);
    }

    public async Task<Result<JobAccepted>> ProposeBackgroundRemovalAsync(
        Guid designId,
        BackgroundRemovalStepCommand command,
        CancellationToken cancellationToken)
    {
        if (command.Mode is not ("ai" or "color-to-alpha" or "none"))
        {
            return Invalid("Background removal mode must be ai, color-to-alpha or none.");
        }

        if (command.Mode == "ai")
        {
            return Invalid(
                "The BiRefNet AI cutout is archived. Use color-to-alpha, or cut the "
                + "artwork out in Photoshop and import the PNG as ready-to-pack.");
        }

        if (command.Mode == "color-to-alpha" && string.IsNullOrWhiteSpace(command.KeyColor))
        {
            return Invalid("color-to-alpha requires a keyColor.");
        }

        if (command.Tolerance is < 0 or > 255)
        {
            return Invalid("Tolerance must be between 0 and 255.");
        }

        if (command.EdgeSoftness is < 0 or > 10)
        {
            return Invalid("Edge softness must be between 0 and 10 pixels.");
        }

        if (command.MaskGrowPx is < -100 or > 100)
        {
            return Invalid("Mask grow/contract must be between -100 and 100 pixels.");
        }

        if (command.AiModel is not null)
        {
            return Invalid("aiModel only applied to the archived ai mode.");
        }

        if (ValidateLevels("maskLevels", command.MaskLevels) is { } maskLevelsError)
        {
            return maskLevelsError;
        }

        if (ValidateLevels("imageLevels", command.ImageLevels) is { } imageLevelsError)
        {
            return imageLevelsError;
        }

        if (command.BrushOps is { Count: > 0 } ops)
        {
            foreach (var (op, index) in ops.Select((op, index) => (op, index)))
            {
                if (op.Tool is not ("erase" or "restore"))
                {
                    return Invalid($"brushOps[{index}].tool must be erase or restore.");
                }

                if (op.RadiusPx is < 1 or > 2000)
                {
                    return Invalid($"brushOps[{index}].radiusPx must be between 1 and 2000.");
                }

                if (op.Points is null || op.Points.Count == 0)
                {
                    return Invalid($"brushOps[{index}] must contain at least one point.");
                }
            }
        }

        var parameters = new
        {
            mode = command.Mode,
            keyColor = command.KeyColor,
            tolerance = command.Tolerance,
            edgeSoftness = command.EdgeSoftness,
            maskGrowPx = command.MaskGrowPx,
            maskLevels = LevelsPayload(command.MaskLevels),
            imageLevels = LevelsPayload(command.ImageLevels),
            aiModel = command.AiModel,
            brushOps = command.BrushOps?.Select(op => new
            {
                tool = op.Tool,
                radiusPx = op.RadiusPx,
                points = op.Points!.Select(point => new[] { point.X, point.Y }).ToArray(),
            }).ToArray(),
        };

        return await EnqueueStepAsync(
            designId,
            JobType.BackgroundRemoval,
            StepType.BackgroundRemoval,
            parameters,
            JobCapability.Image,
            validateParent: null,
            cancellationToken,
            artifactOutputs: new Dictionary<string, string> { ["mask"] = "mask" });
    }

    public async Task<Result<JobAccepted>> ProposeResizeAsync(
        Guid designId,
        ResizeStepCommand command,
        CancellationToken cancellationToken)
    {        if (command.TargetWidthCm <= 0
            || command.TargetHeightCm <= 0
            || command.TargetWidthCm > 500m
            || command.TargetHeightCm > 500m)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.InvalidTargetSize,
                "Target width and height must be greater than 0 and at most 500 cm.");
        }

        if (command.FitMode is not (null or "width" or "height" or "contain"))
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.InvalidRequest,
                "Fit mode must be width, height or contain.");
        }

        return await EnqueueStepAsync(
            designId,
            JobType.Resize,
            StepType.Resize,
            command,
            JobCapability.Image,
            validateParent: null,
            cancellationToken,
            beforeEnqueue: (batch, design) =>
            {
                if (command.TargetWidthCm > batch.Geometry.UsableWidthCm)
                {
                    return Result.Failure(
                        ErrorCodes.DesignExceedsRoll,
                        $"Target width {command.TargetWidthCm} cm exceeds the usable roll width "
                        + $"{batch.Geometry.UsableWidthCm} cm.");
                }

                var update = design.UpdateMetadata(
                    Optional<string>.Unset,
                    Optional<GarmentColor>.Unset,
                    Optional<bool>.Unset,
                    Optional<decimal?>.Set(command.TargetWidthCm),
                    Optional<decimal?>.Set(command.TargetHeightCm),
                    Optional<string?>.Unset,
                    _clock.UtcNow);

                return update;
            });
    }

    private async Task<Result<JobAccepted>> EnqueueStepAsync(
        Guid designId,
        JobType jobType,
        StepType stepType,
        object parameters,
        JobCapability capability,
        Func<DesignVersion, DomainError?>? validateParent,
        CancellationToken cancellationToken,
        Func<Batch, Design, Result>? beforeEnqueue = null,
        IReadOnlyDictionary<string, string>? artifactOutputs = null)
    {
        var batch = await _batches.FindByDesignAsync(designId, cancellationToken);
        var design = batch?.FindDesign(designId);
        if (batch is null || design is null)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.DesignNotFound,
                $"Design {designId} was not found.");
        }

        if (design.Status is DesignStatus.Excluded or DesignStatus.NeedsBetterSource)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.InvalidTransition,
                $"Design is {design.Status.ToContract()} and cannot accept a new proposal.");
        }

        if (design.PendingVersionId is not null)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.ProposalInFlight,
                "A proposed version already exists for this design.");
        }

        if (await _jobs.HasActiveStepJobAsync(design.Id, cancellationToken))
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.JobInFlight,
                "A processing job is already running for this design.");
        }

        var parent = design.CurrentVersion;
        if (parent is null)
        {
            return Result<JobAccepted>.Failure(
                ErrorCodes.VersionNotFound,
                "The design has no current version.");
        }

        if (validateParent is not null && validateParent(parent) is { } parentError)
        {
            return Result<JobAccepted>.Failure(parentError);
        }

        if (beforeEnqueue is not null)
        {
            var before = beforeEnqueue(batch, design);
            if (!before.IsSuccess)
            {
                return Result<JobAccepted>.Failure(before.Error!);
            }
        }

        object jobParameters = parameters;
        if (jobType == JobType.Resize && parameters is ResizeStepCommand resize)
        {
            var dpi = resize.Dpi ?? batch.Geometry.WorkingDpi;
            if (dpi != batch.Geometry.WorkingDpi)
            {
                return Result<JobAccepted>.Failure(
                    ErrorCodes.InvalidRequest,
                    $"Resize DPI must match the batch working DPI ({batch.Geometry.WorkingDpi}).");
            }

            jobParameters = new
            {
                targetWidthCm = resize.TargetWidthCm,
                targetHeightCm = resize.TargetHeightCm,
                targetWidthPx = PrintUnits.PixelsForCentimeters(resize.TargetWidthCm, dpi),
                targetHeightPx = PrintUnits.PixelsForCentimeters(resize.TargetHeightCm, dpi),
                dpi,
                fitMode = resize.FitMode ?? "contain",
            };
        }

        string inputPath = parent.FilePath;
        const string inputArtifactsJson = "{}";

        var versionId = Guid.NewGuid();
        var jobId = Guid.NewGuid();
        var outputPath = $"{(batch.Id)}/designs/{design.Id}/versions/{versionId}.png";

        var context = new
        {
            workingDpi = batch.Geometry.WorkingDpi,
            targetWidthCm = design.TargetWidthCm,
            targetHeightCm = design.TargetHeightCm,
            sourceVersionId = parent.Id,
            originalPath = design.FindVersion(design.OriginalVersionId)?.FilePath ?? parent.FilePath,
            garmentColor = new
            {
                kind = design.GarmentColor.Kind.ToContract(),
                hex = design.GarmentColor.Hex,
            },
        };

        var parametersJson = JsonSerializer.Serialize(jobParameters, ApplicationJson.Options);
        var contextJson = JsonSerializer.Serialize(context, ApplicationJson.Options);
        // The mask is the reviewable artifact for background removal; the worker
        // writes it beside the version image and the API serves it back.
        var outputArtifactsJson = artifactOutputs is null
            ? "{}"
            : JsonSerializer.Serialize(
                artifactOutputs.ToDictionary(
                    pair => pair.Key,
                    pair => $"{(batch.Id)}/designs/{design.Id}/versions/{versionId}.{pair.Value}.png"),
                ApplicationJson.Options);

        var jobResult = Job.Create(
            jobId,
            batch.Id,
            design.Id,
            jobType,
            capability,
            parametersJson,
            contextJson,
            inputPath,
            outputPath,
            inputArtifactsJson,
            outputArtifactsJson,
            Job.DefaultMaxAttempts,
            _clock.UtcNow);

        if (!jobResult.IsSuccess)
        {
            return Result<JobAccepted>.Failure(jobResult.Error!);
        }

        _jobs.Add(jobResult.Value!);
        batch.RecordAudit(
            $"step-{stepType.ToContract()}-queued",
            "operator",
            null,
            design.Id,
            parent.Id,
            parametersJson,
            _clock.UtcNow);

        if (stepType == StepType.Resize)
        {
            batch.InvalidateSheet(_clock.UtcNow);
        }
        else
        {
            batch.Touch(_clock.UtcNow);
        }

        await _batches.SaveChangesAsync(cancellationToken);
        return Result<JobAccepted>.Success(new JobAccepted(jobId, JobStatus.Queued));
    }

    private static Result<JobAccepted> Invalid(string message)
        => Result<JobAccepted>.Failure(ErrorCodes.InvalidRequest, message);

    /// <summary>
    /// Levels are applied with a 256-entry lookup table, so an inverted or empty
    /// input range would silently flatten the whole ramp. Reject it here instead
    /// of writing a version the operator cannot reason about.
    /// </summary>
    private static Result<JobAccepted>? ValidateLevels(
        string name,
        LevelsAdjustmentCommand? levels)
    {
        if (levels is null)
        {
            return null;
        }

        var black = levels.BlackPoint ?? 0;
        var white = levels.WhitePoint ?? 255;
        if (black is < 0 or > 254)
        {
            return Invalid($"{name}.blackPoint must be between 0 and 254.");
        }

        if (white is < 1 or > 255 || white <= black)
        {
            return Invalid($"{name}.whitePoint must be above blackPoint and at most 255.");
        }

        if (levels.Gamma is { } gamma && (gamma < 0.01m || gamma > 9.99m))
        {
            return Invalid($"{name}.gamma must be between 0.01 and 9.99.");
        }

        if (levels.OutputBlack is < 0 or > 255 || levels.OutputWhite is < 0 or > 255)
        {
            return Invalid($"{name} output points must be between 0 and 255.");
        }

        return null;
    }

    private static object? LevelsPayload(LevelsAdjustmentCommand? levels)
        => levels is null
            ? null
            : new
            {
                blackPoint = levels.BlackPoint ?? 0,
                whitePoint = levels.WhitePoint ?? 255,
                gamma = levels.Gamma ?? 1.0m,
                outputBlack = levels.OutputBlack ?? 0,
                outputWhite = levels.OutputWhite ?? 255,
            };
}
