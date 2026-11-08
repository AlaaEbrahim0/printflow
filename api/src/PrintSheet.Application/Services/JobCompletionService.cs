using System.Text.Json;
using System.Text.Json.Nodes;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Common;
using PrintSheet.Application.Settings;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;
using PrintSheet.Domain.Units;

namespace PrintSheet.Application.Services;

/// <summary>
/// Applies worker/packer/export results to the domain. The lease must still be
/// valid; a stale parent or sheet revision fails the job without side effects.
/// </summary>
public sealed class JobCompletionService
{
    private readonly IBatchRepository _batches;
    private readonly IJobRepository _jobs;
    private readonly IFileStore _files;
    private readonly IImageInspector _images;
    private readonly IAppSettingsStore _settings;
    private readonly IClock _clock;

    public JobCompletionService(
        IBatchRepository batches,
        IJobRepository jobs,
        IFileStore files,
        IImageInspector images,
        IAppSettingsStore settings,
        IClock clock)
    {
        _batches = batches;
        _jobs = jobs;
        _files = files;
        _images = images;
        _settings = settings;
        _clock = clock;
    }

    public async Task<Result> CompleteAsync(
        Guid jobId,
        string leaseToken,
        JsonElement result,
        CancellationToken cancellationToken)
    {
        var job = await _jobs.FindAsync(jobId, cancellationToken);
        if (job is null)
        {
            return Result.Failure(ErrorCodes.JobNotFound, $"Job {jobId} was not found.");
        }

        var now = _clock.UtcNow;
        if (job.Status != JobStatus.Running || job.LeaseToken != leaseToken)
        {
            return Result.Failure(
                ErrorCodes.LeaseInvalid,
                "The lease is missing or owned by another worker.");
        }

        if (job.LeaseExpiresAt is { } expiry && expiry <= now)
        {
            return Result.Failure(ErrorCodes.LeaseInvalid, "The lease has expired.");
        }

        if (GetString(result, "schemaVersion") != "1.0")
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "schemaVersion must be '1.0'.");
        }

        if (!TryGetString(result, "jobId", out var resultJobId)
            || !Guid.TryParse(resultJobId, out var parsedJobId)
            || parsedJobId != job.Id)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "The result jobId does not match the job.");
        }

        if (!TryGetString(result, "status", out var status))
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "The result status is required.");
        }

        if (status == "failed")
        {
            var error = ParseError(result);
            if (error is null)
            {
                return Result.Failure(
                    ErrorCodes.InvalidRequest,
                    "A failed result requires an error object.");
            }

            return await FailAndSaveAsync(job, error, now, cancellationToken);
        }

        if (status != "succeeded")
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "The result status must be succeeded or failed.");
        }

        if (!TryGetProperty(result, "metadata", out var metadata)
            || metadata.ValueKind != JsonValueKind.Object)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "The result metadata object is required.");
        }

        var applied = job switch
        {
            _ when job.IsWorkerJob => await ApplyImageResultAsync(job, result, metadata, now, cancellationToken),
            _ when job.Type == JobType.PackSheet => await ApplyPackResultAsync(job, metadata, now, cancellationToken),
            _ when job.Type == JobType.IntegrityCheck => await ApplyIntegrityResultAsync(job, metadata, now, cancellationToken),
            _ when job.Type == JobType.Export => await ApplyExportResultAsync(job, result, metadata, now, cancellationToken),
            _ => Result<string>.Failure(ErrorCodes.InvalidRequest, $"Unsupported job type {job.Type}."),
        };

        if (!applied.IsSuccess)
        {
            return await FailAndSaveAsync(
                job,
                JobError.Create(applied.Error!.Code, applied.Error.Message, retryable: false),
                now,
                cancellationToken);
        }

        var complete = job.Complete(leaseToken, applied.Value!, now);
        if (!complete.IsSuccess)
        {
            return complete;
        }

        await _batches.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }

    public async Task<Result> FailAsync(
        Guid jobId,
        string leaseToken,
        JobError error,
        CancellationToken cancellationToken)
    {
        var job = await _jobs.FindAsync(jobId, cancellationToken);
        if (job is null)
        {
            return Result.Failure(ErrorCodes.JobNotFound, $"Job {jobId} was not found.");
        }

        return await FailAndSaveAsync(job, error, _clock.UtcNow, cancellationToken);
    }

    private async Task<Result<string>> ApplyImageResultAsync(
        Job job,
        JsonElement result,
        JsonElement metadata,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(job.BatchId, cancellationToken);
        var design = job.DesignId is { } designId ? batch?.FindDesign(designId) : null;
        if (batch is null || design is null)
        {
            return Result<string>.Failure(
                ErrorCodes.DesignNotFound,
                "The job's design no longer exists.");
        }

        if (job.Type == JobType.Classify)
        {
            if (!TryGetProperty(result, "suggestions", out var suggestions)
                || suggestions.ValueKind != JsonValueKind.Object)
            {
                return Result<string>.Failure(
                    ErrorCodes.InvalidRequest,
                    "A successful classify result requires suggestions.");
            }

            design.SetSuggestions(suggestions.GetRawText(), now);
            batch.Touch(now);
            batch.RecordAudit(
                "classifier-suggestions-received",
                "worker",
                null,
                design.Id,
                null,
                null,
                now);

            var classifyResult = new JsonObject
            {
                ["schemaVersion"] = "1.0",
                ["jobId"] = job.Id,
                ["status"] = "succeeded",
                ["metadata"] = JsonNode.Parse(metadata.GetRawText()),
                ["suggestions"] = JsonNode.Parse(suggestions.GetRawText()),
            };
            return Result<string>.Success(classifyResult.ToJsonString(ApplicationJson.Web));
        }

        if (!TryGetString(result, "outputPath", out var outputPath))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "A successful image job requires outputPath.");
        }

        if (!await _files.ExistsAsync(outputPath, cancellationToken))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The worker output file is missing from storage.");
        }

        ImageInspection inspection;
        using (var stream = await _files.OpenReadAsync(outputPath, cancellationToken))
        {
            inspection = await _images.InspectAsync(stream, cancellationToken);
        }

        var declaredWidth = GetInt(metadata, "widthPx");
        var declaredHeight = GetInt(metadata, "heightPx");
        if (declaredWidth is not null && declaredWidth != inspection.WidthPx)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                $"Declared width {declaredWidth} does not match the output {inspection.WidthPx}.");
        }

        if (declaredHeight is not null && declaredHeight != inspection.HeightPx)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                $"Declared height {declaredHeight} does not match the output {inspection.HeightPx}.");
        }

        var versionId = ReadVersionId(outputPath);
        if (versionId is null)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The output path does not contain a version id.");
        }

        var context = ParseObject(job.ContextJson);
        var parentId = GetGuid(context, "sourceVersionId");
        if (parentId is null)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The job context is missing sourceVersionId.");
        }

        if (design.CurrentVersionId != parentId)
        {
            return Result<string>.Failure(
                ErrorCodes.StaleSource,
                "The current version changed while the job was running; the result was discarded.");
        }

        var stepType = ResolveStepType(job);
        string? maskPath = null;
        string? svgPath = null;
        if (TryGetProperty(result, "outputArtifacts", out var artifacts)
            && artifacts.ValueKind == JsonValueKind.Object)
        {
            if (TryGetString(artifacts, "mask", out var mask))
            {
                maskPath = mask;
                if (!await _files.ExistsAsync(mask, cancellationToken))
                {
                    return Result<string>.Failure(
                        ErrorCodes.InvalidRequest,
                        "The mask artifact is missing from storage.");
                }
            }

            if (TryGetString(artifacts, "svg", out var svg))
            {
                svgPath = svg;
                if (!await _files.ExistsAsync(svg, cancellationToken))
                {
                    return Result<string>.Failure(
                        ErrorCodes.InvalidRequest,
                        "The SVG artifact is missing from storage.");
                }
            }
        }

        var hasAlpha = GetBool(metadata, "hasAlpha") ?? inspection.HasAlpha;
        var versionResult = DesignVersion.CreateProposal(
            versionId.Value,
            design.Id,
            parentId.Value,
            stepType,
            outputPath,
            maskPath,
            svgPath,
            inspection.WidthPx,
            inspection.HeightPx,
            hasAlpha,
            job.ParametersJson,
            job.Id,
            now);

        if (!versionResult.IsSuccess)
        {
            return Result<string>.Failure(versionResult.Error!);
        }

        var proposal = design.AddProposal(versionResult.Value!, now);
        if (!proposal.IsSuccess)
        {
            return Result<string>.Failure(proposal.Error!);
        }

        batch.Touch(now);
        batch.RecordAudit(
            $"step-{stepType.ToContract()}-proposed",
            "worker",
            null,
            design.Id,
            versionId,
            null,
            now);

        var jobResult = new JsonObject
        {
            ["schemaVersion"] = "1.0",
            ["jobId"] = job.Id,
            ["status"] = "succeeded",
            ["outputVersionId"] = versionId,
            ["outputPath"] = outputPath,
            ["outputArtifacts"] = JsonNode.Parse(
                TryGetProperty(result, "outputArtifacts", out var rawArtifacts)
                    ? rawArtifacts.GetRawText()
                    : "{}"),
            ["metadata"] = JsonNode.Parse(metadata.GetRawText()),
        };

        return Result<string>.Success(jobResult.ToJsonString(ApplicationJson.Web));
    }

    private async Task<Result<string>> ApplyPackResultAsync(
        Job job,
        JsonElement metadata,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(job.BatchId, cancellationToken);
        if (batch is null)
        {
            return Result<string>.Failure(
                ErrorCodes.BatchNotFound,
                "The job's batch no longer exists.");
        }

        JsonElement response = metadata;
        if (TryGetProperty(metadata, "packerResponse", out var embedded)
            && embedded.ValueKind == JsonValueKind.Object)
        {
            response = embedded;
        }

        if (!TryGetProperty(response, "placements", out _)
            || !TryGetProperty(response, "sheet", out _)
            || !TryGetProperty(response, "unplacedDesigns", out var unplacedElement)
            || unplacedElement.ValueKind != JsonValueKind.Array
            || !TryGetProperty(response, "integrityReport", out var packingReport)
            || packingReport.ValueKind != JsonValueKind.Object
            || !TryGetBool(packingReport, "passed", out var packingPassed))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The pack result must contain a packer response with sheet, placements, unplaced designs and integrity report.");
        }

        var requestId = GetString(response, "requestId");
        if (requestId != job.Id.ToString())
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The packer response requestId does not match the job.");
        }

        var context = ParseObject(job.ContextJson);
        var sheetId = GetGuid(context, "sheetId");
        var revision = GetInt(context, "revision");
        if (sheetId is null || revision is null)
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The pack context is incomplete.");
        }

        if (batch.CurrentRevision >= revision.Value)
        {
            return Result<string>.Failure(
                ErrorCodes.StaleRevision,
                $"The pack result targets revision {revision}, which is no longer current.");
        }

        var snapshot = ReadDesignSnapshot(context);
        if (snapshot.Count == 0)
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The pack context has no designs.");
        }

        var requestedDesignIds = ReadGuidArray(context, "requestedDesignIds");
        if (requestedDesignIds.Count == 0
            || requestedDesignIds.Distinct().Count() != requestedDesignIds.Count
            || requestedDesignIds.Any(designId => !snapshot.ContainsKey(designId)))
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The requested design selection is invalid.");
        }

        foreach (var (designId, versionId) in snapshot)
        {
            var design = batch.FindDesign(designId);
            if (design is null || design.CurrentVersionId != versionId)
            {
                return Result<string>.Failure(
                    ErrorCodes.StaleSource,
                    "A design's current version changed while packing; repack the sheet.");
            }
        }

        if (!TryGetProperty(response, "sheet", out var sheetElement)
            || !TryGetProperty(response, "outputs", out var outputs)
            || !TryGetProperty(response, "placements", out var placementsElement)
            || placementsElement.ValueKind != JsonValueKind.Array)
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The packer response is incomplete.");
        }

        var widthPx = GetInt(sheetElement, "widthPx");
        var heightPx = GetInt(sheetElement, "heightPx");
        var widthCm = GetDecimal(sheetElement, "widthCm");
        var heightCm = GetDecimal(sheetElement, "heightCm");
        var dpi = GetInt(sheetElement, "dpi");
        if (widthPx is null || heightPx is null || widthCm is null || heightCm is null || dpi is null)
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The sheet geometry is incomplete.");
        }

        if (dpi != batch.Geometry.WorkingDpi)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The packed sheet DPI does not match the batch DPI.");
        }

        if (widthPx != PrintUnits.PixelsForCentimeters(batch.Geometry.RollWidthCm, dpi.Value))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The packed sheet width does not match the roll width.");
        }

        var placements = new List<Placement>();
        var seen = new HashSet<Guid>();
        foreach (var element in placementsElement.EnumerateArray())
        {
            if (!TryGetGuid(element, "designId", out var designId)
                || !TryGetGuid(element, "versionId", out var versionId)
                || !TryGetDecimal(element, "xCm", out var xCm)
                || !TryGetDecimal(element, "yCm", out var yCm)
                || !TryGetDecimal(element, "widthCm", out var placementWidthCm)
                || !TryGetDecimal(element, "heightCm", out var placementHeightCm)
                || !TryGetInt(element, "widthPx", out var placementWidthPx)
                || !TryGetInt(element, "heightPx", out var placementHeightPx)
                || !TryGetInt(element, "rotationDeg", out var rotationDeg))
            {
                return Result<string>.Failure(ErrorCodes.InvalidRequest, "A placement is malformed.");
            }

            if (!requestedDesignIds.Contains(designId)
                || !snapshot.TryGetValue(designId, out var expectedVersion)
                || expectedVersion != versionId)
            {
                return Result<string>.Failure(
                    ErrorCodes.StaleSource,
                    "A placement references a version that is not the snapshotted current version.");
            }

            if (!seen.Add(designId))
            {
                return Result<string>.Failure(
                    ErrorCodes.InvalidRequest,
                    $"Design {designId} is placed more than once.");
            }

            var placementResult = Placement.Create(
                designId,
                versionId,
                GetString(element, "displayName") ?? GetString(element, "designName"),
                xCm,
                yCm,
                placementWidthCm,
                placementHeightCm,
                placementWidthPx,
                placementHeightPx,
                rotationDeg);

            if (!placementResult.IsSuccess)
            {
                return Result<string>.Failure(placementResult.Error!);
            }

            placements.Add(placementResult.Value!);
        }

        var unplaced = new List<(Guid DesignId, string Reason)>();
        foreach (var element in unplacedElement.EnumerateArray())
        {
            if (!TryGetGuid(element, "designId", out var designId)
                || !TryGetProperty(element, "reason", out var reasonElement)
                || reasonElement.ValueKind != JsonValueKind.String)
            {
                return Result<string>.Failure(ErrorCodes.InvalidRequest, "An unplaced-design entry is malformed.");
            }

            if (!requestedDesignIds.Contains(designId)
                || !snapshot.ContainsKey(designId)
                || !seen.Add(designId))
            {
                return Result<string>.Failure(
                    ErrorCodes.InvalidRequest,
                    $"Unplaced design {designId} is not a unique snapshotted design.");
            }

            unplaced.Add((designId, reasonElement.GetString()!));
        }

        if (requestedDesignIds.Any(designId => !seen.Contains(designId)))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The packer response does not account for every selected design.");
        }

        var omittedDesigns = snapshot.Keys
            .Where(designId => !requestedDesignIds.Contains(designId))
            .Select(designId => (DesignId: designId, Reason: "not-selected"))
            .ToArray();
        var allUnplaced = unplaced.Concat(omittedDesigns).ToList();
        if (unplaced.Count > 0 && packingPassed)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The packing integrity report must fail when selected designs are unplaced.");
        }

        var previewPath = GetString(outputs, "previewPath");
        var manifestPath = GetString(outputs, "manifestPath");
        if (string.IsNullOrWhiteSpace(manifestPath) || string.IsNullOrWhiteSpace(previewPath))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The packer response is missing its preview or manifest path.");
        }

        var settings = await _settings.GetAsync(cancellationToken);
        var costResult = Money.Create(settings.EstimatedCost(heightCm.Value), settings.Currency);
        if (!costResult.IsSuccess)
        {
            return Result<string>.Failure(costResult.Error!);
        }

        var sheetResult = Sheet.CreatePacked(
            sheetId.Value,
            batch.Id,
            revision.Value,
            widthCm.Value,
            heightCm.Value,
            widthPx.Value,
            heightPx.Value,
            dpi.Value,
            placements,
            costResult.Value!,
            previewPath,
            manifestPath,
            now);

        if (!sheetResult.IsSuccess)
        {
            return Result<string>.Failure(sheetResult.Error!);
        }

        if (!TryUpdateCompletenessReport(
            packingReport,
            packingPassed,
            snapshot.Count,
            placements.Count,
            allUnplaced,
            out var packingReportJson))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The packing integrity report is missing its all-designs-placed check.");
        }

        var storedReport = sheetResult.Value!.StorePackingReport(
            packingReportJson,
            now);
        if (!storedReport.IsSuccess)
        {
            return Result<string>.Failure(storedReport.Error!);
        }

        var added = batch.AddSheet(sheetResult.Value!, "packer", now);
        if (!added.IsSuccess)
        {
            return Result<string>.Failure(added.Error!);
        }

        var summary = new JsonObject
        {
            ["schemaVersion"] = "1.0",
            ["jobId"] = job.Id,
            ["status"] = "succeeded",
            ["outputPath"] = manifestPath,
            ["metadata"] = new JsonObject
            {
                ["durationMs"] = GetInt(metadata, "durationMs") ?? 0,
                ["placementCount"] = placements.Count,
                ["unplacedDesigns"] = new JsonArray(allUnplaced.Select(item => new JsonObject
                {
                    ["designId"] = item.DesignId,
                    ["reason"] = item.Reason,
                }).ToArray()),
                ["sheetWidthPx"] = widthPx,
                ["sheetHeightPx"] = heightPx,
            },
        };

        return Result<string>.Success(summary.ToJsonString(ApplicationJson.Web));
    }

    private async Task<Result<string>> ApplyIntegrityResultAsync(
        Job job,
        JsonElement metadata,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(job.BatchId, cancellationToken);
        if (batch is null)
        {
            return Result<string>.Failure(
                ErrorCodes.BatchNotFound,
                "The job's batch no longer exists.");
        }

        if (!TryGetProperty(metadata, "report", out var report)
            || report.ValueKind != JsonValueKind.Object)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The integrity result must contain a report object.");
        }

        var context = ParseObject(job.ContextJson);
        var sheetId = GetGuid(context, "sheetId");
        var revision = GetInt(context, "revision");
        if (sheetId is null || revision is null)
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The integrity context is incomplete.");
        }

        var sheet = batch.CurrentSheet;
        if (sheet is null || sheet.Id != sheetId || sheet.Revision != revision)
        {
            return Result<string>.Failure(
                ErrorCodes.StaleRevision,
                "The sheet revision changed while the integrity check was running.");
        }

        if (sheet.Stale)
        {
            return Result<string>.Failure(
                ErrorCodes.SheetStale,
                "The sheet became stale while the integrity check was running.");
        }

        if (!TryGetProperty(report, "sheet", out var reportSheet)
            || GetInt(reportSheet, "widthPx") != sheet.WidthPx
            || GetInt(reportSheet, "heightPx") != sheet.HeightPx
            || GetInt(reportSheet, "dpi") != sheet.Dpi)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The integrity report geometry does not match the current sheet.");
        }

        if (!TryGetBool(report, "passed", out var reportedPassed))
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The report must include passed.");
        }

        var missingDesigns = batch.IncludedDesigns
            .Where(design => sheet.Placements.All(placement => placement.DesignId != design.Id))
            .Select(design => (DesignId: design.Id, Reason: "not-placed"))
            .ToArray();
        if (!TryUpdateCompletenessReport(
            report,
            reportedPassed,
            batch.IncludedDesigns.Count,
            sheet.Placements.Count,
            missingDesigns,
            out var reportJson))
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The integrity report is missing its all-designs-placed check.");
        }

        using var normalizedReport = JsonDocument.Parse(reportJson);
        if (!TryGetBool(normalizedReport.RootElement, "passed", out var passed))
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The normalized report is invalid.");
        }

        var applied = sheet.ApplyIntegrityReport(passed, reportJson, now);
        if (!applied.IsSuccess)
        {
            return Result<string>.Failure(applied.Error!);
        }

        batch.Touch(now);
        batch.RecordAudit(
            passed ? "integrity-passed" : "integrity-failed",
            "packer",
            null,
            null,
            null,
            null,
            now);

        var summary = new JsonObject
        {
            ["schemaVersion"] = "1.0",
            ["jobId"] = job.Id,
            ["status"] = "succeeded",
            ["metadata"] = new JsonObject { ["durationMs"] = GetInt(metadata, "durationMs") ?? 0 },
            ["integrityReport"] = JsonNode.Parse(reportJson),
        };

        return Result<string>.Success(summary.ToJsonString(ApplicationJson.Web));
    }

    private async Task<Result<string>> ApplyExportResultAsync(
        Job job,
        JsonElement result,
        JsonElement metadata,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var batch = await _batches.FindAsync(job.BatchId, cancellationToken);
        if (batch is null)
        {
            return Result<string>.Failure(
                ErrorCodes.BatchNotFound,
                "The job's batch no longer exists.");
        }

        var context = ParseObject(job.ContextJson);
        var exportId = GetGuid(context, "exportId");
        if (exportId is null)
        {
            return Result<string>.Failure(ErrorCodes.InvalidRequest, "The export context is incomplete.");
        }

        var export = batch.FindExport(exportId.Value);
        if (export is null)
        {
            return Result<string>.Failure(
                ErrorCodes.ExportNotFound,
                "The export record no longer exists.");
        }

        var sheet = batch.CurrentSheet;
        if (sheet is null
            || sheet.Id != export.SheetId
            || sheet.Revision != export.SheetRevision
            || sheet.Stale
            || sheet.State != SheetState.Valid)
        {
            return Result<string>.Failure(
                ErrorCodes.SheetStale,
                "The sheet changed while the export was running; the export was discarded.");
        }

        if (!TryGetProperty(result, "outputArtifacts", out var artifacts)
            || artifacts.ValueKind != JsonValueKind.Object)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "A successful export requires outputArtifacts.");
        }

        var exported = new List<ExportArtifact>();
        foreach (var property in artifacts.EnumerateObject())
        {
            if (!ExportArtifactNameExtensions.TryParseContract(property.Name, out var name))
            {
                continue;
            }

            var path = property.Value.GetString();
            if (string.IsNullOrWhiteSpace(path))
            {
                continue;
            }

            if (!await _files.ExistsAsync(path, cancellationToken))
            {
                return Result<string>.Failure(
                    ErrorCodes.InvalidRequest,
                    $"The export artifact '{property.Name}' is missing from storage.");
            }

            var length = await _files.GetLengthAsync(path, cancellationToken);
            var artifact = ExportArtifact.Create(
                name,
                ContentTypeFor(export.Format, name, path),
                length,
                path);

            if (!artifact.IsSuccess)
            {
                return Result<string>.Failure(artifact.Error!);
            }

            exported.Add(artifact.Value!);
        }

        if (exported.Count == 0)
        {
            return Result<string>.Failure(
                ErrorCodes.InvalidRequest,
                "The export produced no known artifacts.");
        }

        var marked = export.MarkSucceeded(exported, now);
        if (!marked.IsSuccess)
        {
            return Result<string>.Failure(marked.Error!);
        }

        batch.Touch(now);
        batch.RecordAudit("export-succeeded", "exporter", null, null, null, null, now);

        var summary = new JsonObject
        {
            ["schemaVersion"] = "1.0",
            ["jobId"] = job.Id,
            ["status"] = "succeeded",
            ["exportId"] = export.Id,
            ["metadata"] = new JsonObject { ["durationMs"] = GetInt(metadata, "durationMs") ?? 0 },
            ["outputArtifacts"] = JsonNode.Parse(artifacts.GetRawText()),
        };

        return Result<string>.Success(summary.ToJsonString(ApplicationJson.Web));
    }

    private async Task<Result> FailAndSaveAsync(
        Job job,
        JobError error,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var failed = job.Fail(job.LeaseToken ?? string.Empty, error, now);
        if (!failed.IsSuccess)
        {
            return failed;
        }

        if (job.Type == JobType.Export && job.Status == JobStatus.Failed)
        {
            var batch = await _batches.FindAsync(job.BatchId, cancellationToken);
            var context = ParseObject(job.ContextJson);
            if (batch is not null && GetGuid(context, "exportId") is { } exportId)
            {
                var record = batch.FindExport(exportId);
                record?.MarkFailed(
                    JsonSerializer.Serialize(error, ApplicationJson.Web),
                    now);
            }
        }

        await _batches.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }

    private StepType ResolveStepType(Job job)
    {
        if (job.Type == JobType.Trim)
        {
            var parameters = ParseObject(job.ParametersJson);
            if (GetString(parameters, "mode") == "manual")
            {
                return StepType.Crop;
            }
        }

        return job.Type switch
        {
            JobType.Classify => StepType.Original,
            JobType.Trim => StepType.Trim,
            JobType.BackgroundRemoval => StepType.BackgroundRemoval,
            JobType.Upscale => StepType.Upscale,
            JobType.Vectorize => StepType.Vectorize,
            JobType.Resize => StepType.Resize,
            _ => StepType.Trim,
        };
    }

    private static Dictionary<Guid, Guid> ReadDesignSnapshot(JsonElement context)
    {
        var snapshot = new Dictionary<Guid, Guid>();
        if (!TryGetProperty(context, "designs", out var designs)
            || designs.ValueKind != JsonValueKind.Array)
        {
            return snapshot;
        }

        foreach (var design in designs.EnumerateArray())
        {
            if (TryGetGuid(design, "designId", out var designId)
                && TryGetGuid(design, "versionId", out var versionId))
            {
                snapshot[designId] = versionId;
            }
        }

        return snapshot;
    }

    private static IReadOnlyList<Guid> ReadGuidArray(JsonElement element, string name)
    {
        if (!TryGetProperty(element, name, out var values) || values.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<Guid>();
        foreach (var value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String
                || !Guid.TryParse(value.GetString(), out var id)
                || id == Guid.Empty)
            {
                return [];
            }

            result.Add(id);
        }

        return result;
    }

    private static bool TryUpdateCompletenessReport(
        JsonElement source,
        bool originalPassed,
        int requestedCount,
        int placedCount,
        IReadOnlyList<(Guid DesignId, string Reason)> unplaced,
        out string reportJson)
    {
        reportJson = string.Empty;
        if (requestedCount < 1
            || placedCount < 0
            || !JsonNode.Parse(source.GetRawText())!.AsObject().TryGetPropertyValue("checks", out var checksNode)
            || checksNode is not JsonArray checks)
        {
            return false;
        }

        var completenessCheck = checks
            .OfType<JsonObject>()
            .FirstOrDefault(check =>
                check["id"] is JsonValue idNode
                && idNode.TryGetValue<string>(out var id)
                && id == "all-designs-placed");
        if (completenessCheck is null
            || completenessCheck["details"] is not JsonObject details
            || !JsonNode.Parse(source.GetRawText())!.AsObject().TryGetPropertyValue("failures", out var failuresNode)
            || failuresNode is not JsonArray failures
            || !JsonNode.Parse(source.GetRawText())!.AsObject().TryGetPropertyValue("metrics", out var metricsNode)
            || metricsNode is not JsonObject metrics)
        {
            return false;
        }

        var report = JsonNode.Parse(source.GetRawText())!.AsObject();
        var reportChecks = report["checks"]!.AsArray();
        completenessCheck = reportChecks
            .OfType<JsonObject>()
            .First(check =>
                check["id"] is JsonValue idNode
                && idNode.TryGetValue<string>(out var id)
                && id == "all-designs-placed");
        details = completenessCheck["details"]!.AsObject();
        details["requestedDesignCount"] = requestedCount;
        details["placedDesignCount"] = placedCount;
        details["unplacedDesigns"] = new JsonArray(unplaced.Select(item => new JsonObject
        {
            ["designId"] = item.DesignId,
            ["reason"] = item.Reason,
            ["details"] = new JsonObject(),
        }).ToArray());
        completenessCheck["status"] = unplaced.Count == 0 ? "passed" : "failed";
        completenessCheck["message"] = unplaced.Count == 0
            ? $"All {requestedCount} requested design(s) are placed."
            : $"{placedCount} of {requestedCount} required design(s) are placed; {unplaced.Count} remain unplaced.";
        report["passed"] = originalPassed && unplaced.Count == 0;

        var reportFailures = report["failures"]!.AsArray();
        for (var index = reportFailures.Count - 1; index >= 0; index--)
        {
            if (reportFailures[index] is JsonObject failure
                && failure["checkId"] is JsonValue checkIdNode
                && checkIdNode.TryGetValue<string>(out var checkId)
                && checkId == "all-designs-placed")
            {
                reportFailures.RemoveAt(index);
            }
        }

        foreach (var item in unplaced)
        {
            reportFailures.Add(new JsonObject
            {
                ["checkId"] = "all-designs-placed",
                ["designId"] = item.DesignId,
                ["message"] = $"Design {item.DesignId} is unplaced: {item.Reason}.",
                ["details"] = new JsonObject(),
            });
        }

        var reportMetrics = report["metrics"]!.AsObject();
        reportMetrics["requestedDesignCount"] = requestedCount;
        reportMetrics["designCount"] = placedCount;
        reportMetrics["unplacedDesignCount"] = unplaced.Count;
        reportJson = report.ToJsonString(ApplicationJson.Web);
        return true;
    }

    private static Guid? ReadVersionId(string outputPath)
    {
        var stem = Path.GetFileNameWithoutExtension(outputPath);
        return Guid.TryParse(stem, out var id) ? id : null;
    }

    private static string ContentTypeFor(ExportFormat format, ExportArtifactName name, string path)
    {
        if (name == ExportArtifactName.Flat)
        {
            return format == ExportFormat.FlatTiff ? "image/tiff" : "image/png";
        }

        return name switch
        {
            ExportArtifactName.Preview => "image/png",
            ExportArtifactName.Manifest => "application/json",
            ExportArtifactName.Jsx => "text/javascript",
            ExportArtifactName.Layered => "image/vnd.adobe.photoshop",
            _ => "application/octet-stream",
        };
    }

    private static JobError? ParseError(JsonElement result)
    {
        if (!TryGetProperty(result, "error", out var error)
            || error.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var code = GetString(error, "code");
        var message = GetString(error, "message");
        var retryable = TryGetBool(error, "retryable", out var retry) && retry;
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(message))
        {
            return null;
        }

        var details = TryGetProperty(error, "details", out var detailsElement)
            ? detailsElement.GetRawText()
            : null;

        return JobError.Create(code, message, retryable, details);
    }

    private static JsonElement ParseObject(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static bool TryGetProperty(JsonElement element, string name, out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value))
        {
            return true;
        }

        value = default;
        return false;
    }

    private static string? GetString(JsonElement element, string name)
        => TryGetString(element, name, out var value) ? value : null;

    private static bool TryGetString(JsonElement element, string name, out string value)
    {
        if (TryGetProperty(element, name, out var property)
            && property.ValueKind == JsonValueKind.String)
        {
            value = property.GetString() ?? string.Empty;
            return !string.IsNullOrWhiteSpace(value);
        }

        value = string.Empty;
        return false;
    }

    private static int? GetInt(JsonElement element, string name)
        => TryGetInt(element, name, out var value) ? value : null;

    private static bool TryGetInt(JsonElement element, string name, out int value)
    {
        if (TryGetProperty(element, name, out var property)
            && property.ValueKind == JsonValueKind.Number
            && property.TryGetInt32(out value))
        {
            return true;
        }

        value = 0;
        return false;
    }

    private static decimal? GetDecimal(JsonElement element, string name)
        => TryGetDecimal(element, name, out var value) ? value : null;

    private static bool TryGetDecimal(JsonElement element, string name, out decimal value)
    {
        if (TryGetProperty(element, name, out var property)
            && property.ValueKind == JsonValueKind.Number
            && property.TryGetDecimal(out value))
        {
            return true;
        }

        value = 0m;
        return false;
    }

    private static bool? GetBool(JsonElement element, string name)
        => TryGetBool(element, name, out var value) ? value : null;

    private static bool TryGetBool(JsonElement element, string name, out bool value)
    {
        if (TryGetProperty(element, name, out var property)
            && property.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            value = property.GetBoolean();
            return true;
        }

        value = false;
        return false;
    }

    private static Guid? GetGuid(JsonElement element, string name)
        => TryGetGuid(element, name, out var value) ? value : null;

    private static bool TryGetGuid(JsonElement element, string name, out Guid value)
    {
        if (TryGetString(element, name, out var text) && Guid.TryParse(text, out value))
        {
            return true;
        }

        value = Guid.Empty;
        return false;
    }
}
