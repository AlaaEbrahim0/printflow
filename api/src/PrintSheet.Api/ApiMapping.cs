using System.Text.Json;
using PrintSheet.Api.Contracts;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Api;

/// <summary>Maps domain entities to the frozen contract shapes.</summary>
public static class ApiMapping
{
    public static BatchSummaryDto ToSummary(this Batch batch, Sheet? currentSheet)
        => new(
            batch.Id,
            batch.Name,
            batch.Status.ToContract(),
            batch.Geometry.RollWidthCm,
            batch.Geometry.MarginMm,
            batch.Geometry.EdgeMarginMm,
            batch.Geometry.WorkingDpi,
            batch.DesignCount,
            batch.ReadyCount,
            batch.ExcludedCount,
            currentSheet?.HeightCm,
            batch.CreatedAt,
            batch.UpdatedAt);

    public static BatchDetailDto ToDetail(this Batch batch)
        => new(
            batch.Id,
            batch.Name,
            batch.Status.ToContract(),
            batch.Geometry.RollWidthCm,
            batch.Geometry.MarginMm,
            batch.Geometry.EdgeMarginMm,
            batch.Geometry.WorkingDpi,
            batch.DesignCount,
            batch.ReadyCount,
            batch.ExcludedCount,
            batch.CurrentSheet?.HeightCm,
            batch.CreatedAt,
            batch.UpdatedAt,
            batch.Designs.Select(design => design.ToSummary()).ToList(),
            batch.CurrentSheet?.ToDto());

    public static DesignSummaryDto ToSummary(this Design design)
        => new(
            design.Id,
            design.BatchId,
            design.Name,
            design.Status.ToContract(),
            new GarmentColorDto(design.GarmentColor.Kind.ToContract(), design.GarmentColor.Hex),
            design.AllowRotation,
            design.OriginalVersionId,
            design.CurrentVersionId,
            design.TargetWidthCm,
            design.TargetHeightCm,
            design.EffectiveDpi,
            design.VersionCount,
            design.CurrentVersion?.ToSummary(),
            design.PendingVersion?.ToSummary(),
            design.Notes,
            design.CreatedAt,
            design.UpdatedAt);

    public static DesignDetailDto ToDetail(this Design design)
        => new(
            design.Id,
            design.BatchId,
            design.Name,
            design.Status.ToContract(),
            new GarmentColorDto(design.GarmentColor.Kind.ToContract(), design.GarmentColor.Hex),
            design.AllowRotation,
            design.OriginalVersionId,
            design.CurrentVersionId,
            design.TargetWidthCm,
            design.TargetHeightCm,
            design.EffectiveDpi,
            design.VersionCount,
            design.CurrentVersion?.ToSummary(),
            design.PendingVersion?.ToSummary(),
            design.Notes,
            design.CreatedAt,
            design.UpdatedAt,
            design.Versions.Select(version => version.ToDto()).ToList());

    public static VersionSummaryDto ToSummary(this DesignVersion version)
        => new(
            version.Id,
            version.DesignId,
            version.ParentId,
            version.StepType.ToContract(),
            version.Status.ToContract(),
            version.WidthPx,
            version.HeightPx,
            version.HasAlpha,
            version.CreatedAt,
            FileUrl(version.DesignId, version.Id));

    public static DesignVersionDto ToDto(this DesignVersion version)
        => new(
            version.Id,
            version.DesignId,
            version.ParentId,
            version.StepType.ToContract(),
            version.Status.ToContract(),
            version.WidthPx,
            version.HeightPx,
            version.HasAlpha,
            version.CreatedAt,
            FileUrl(version.DesignId, version.Id),
            ParseJson(version.ParametersJson),
            new VersionArtifactsDto(
                version.MaskPath is null ? null : $"/api/v1/designs/{version.DesignId}/versions/{version.Id}/mask",
                version.SvgPath is null ? null : $"/api/v1/designs/{version.DesignId}/versions/{version.Id}/svg"),
            version.ApprovedAt,
            version.RejectedAt);

    public static SheetDto ToDto(this Sheet sheet)
        => new(
            sheet.Id,
            sheet.BatchId,
            sheet.Revision,
            sheet.State.ToContract(),
            sheet.WidthCm,
            sheet.HeightCm,
            sheet.WidthPx,
            sheet.HeightPx,
            sheet.Dpi,
            sheet.Placements.Select(placement => placement.ToDto()).ToList(),
            ParseJsonOrNull(sheet.IntegrityReportJson),
            sheet.Stale,
            new MoneyDto(sheet.EstimatedCost.Amount, sheet.EstimatedCost.Currency),
            sheet.CreatedAt,
            sheet.UpdatedAt);

    public static PlacementDto ToDto(this Placement placement)
        => new(
            placement.DesignId,
            placement.VersionId,
            placement.DesignName,
            placement.XCm,
            placement.YCm,
            placement.WidthCm,
            placement.HeightCm,
            placement.WidthPx,
            placement.HeightPx,
            placement.RotationDeg);

    public static ExportDto ToDto(this ExportRecord export)
        => new(
            export.Id,
            export.BatchId,
            export.SheetRevision,
            export.Format.ToContract(),
            export.Status.ToContract(),
            export.Dpi,
            export.Artifacts
                .Select(artifact => new ExportArtifactDto(
                    artifact.Name.ToContract(),
                    artifact.ContentType,
                    artifact.SizeBytes,
                    $"/api/v1/exports/{export.Id}/download?artifact={artifact.Name.ToContract()}"))
                .ToList(),
            ParseJsonOrNull(export.IntegrityReportJson),
            export.BlockedReason,
            ParseJsonOrNull(export.ErrorJson),
            export.CreatedAt,
            export.CompletedAt);

    public static JobDto ToDto(this Job job)
        => new(
            job.Id,
            job.BatchId,
            job.DesignId,
            job.Type.ToContract(),
            job.Status.ToContract(),
            ParseJson(job.ParametersJson),
            ParseJsonOrNull(job.ResultJson),
            ParseJobErrorOrNull(job.ErrorJson),
            job.Attempts,
            job.CreatedAt,
            job.StartedAt,
            job.CompletedAt,
            job.DurationMs);

    public static ClassifierSuggestionsDto ToSuggestions(this Design design)
    {
        if (design.SuggestionsJson is { Length: > 0 } json)
        {
            var element = ParseJson(json);
            return new ClassifierSuggestionsDto(
                design.Id,
                design.SuggestionsStatus ?? "ready",
                design.SuggestionsAnalyzedAt,
                GetPropertyOrNull(element, "source"),
                GetPropertyOrNull(element, "features"),
                GetPropertyOrNull(element, "suggestions"));
        }

        return new ClassifierSuggestionsDto(
            design.Id,
            design.SuggestionsStatus ?? "pending",
            design.SuggestionsAnalyzedAt,
            null,
            null,
            null);
    }

    public static JsonElement ParseJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    public static JsonElement? ParseJsonOrNull(string? json)
        => string.IsNullOrWhiteSpace(json) ? null : ParseJson(json);

    public static JobErrorDto? ParseJobErrorOrNull(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        var error = ParseJson(json);
        if (error.ValueKind != JsonValueKind.Object
            || !error.TryGetProperty("Retryable", out var retryable)
            || retryable.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new JsonException("Stored job error has an invalid shape.");
        }

        JsonElement? details = null;
        if (error.TryGetProperty("DetailsJson", out var detailsJson)
            && detailsJson.ValueKind != JsonValueKind.Null)
        {
            if (detailsJson.ValueKind != JsonValueKind.String)
            {
                throw new JsonException("Stored job error details must be a JSON string.");
            }

            var detailsText = detailsJson.GetString();
            if (!string.IsNullOrWhiteSpace(detailsText))
            {
                details = ParseJson(detailsText);
            }
        }

        return new JobErrorDto(
            GetRequiredString(error, "Code"),
            GetRequiredString(error, "Message"),
            retryable.GetBoolean(),
            details);
    }

    public static JsonElement? GetPropertyOrNull(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value)
            ? value.Clone()
            : null;

    private static string GetRequiredString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw new JsonException($"Stored job error is missing its {name} field.");
        }

        return value.GetString()
            ?? throw new JsonException($"Stored job error has a null {name} field.");
    }

    public static string FileUrl(Guid designId, Guid versionId)
        => $"/api/v1/designs/{designId}/versions/{versionId}/file";
}
