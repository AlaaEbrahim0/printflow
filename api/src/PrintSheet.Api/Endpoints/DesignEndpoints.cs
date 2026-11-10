using System.Text.Json;
using PrintSheet.Api.Contracts;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Services;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Api.Endpoints;

public static class DesignEndpoints
{
    private static readonly string[] RejectNextActions =
        ["adjust-parameters", "manual-tool", "skip"];

    public static void MapDesignEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/designs").WithTags("Designs");

        group.MapGet("/{designId:guid}", GetAsync);
        group.MapPatch("/{designId:guid}", UpdateAsync);
        group.MapGet("/{designId:guid}/suggestions", SuggestionsAsync);
        group.MapGet("/{designId:guid}/versions", VersionsAsync);
        group.MapGet("/{designId:guid}/versions/{versionId:guid}/file", FileAsync);
        group.MapGet("/{designId:guid}/versions/{versionId:guid}/mask", MaskAsync);
        group.MapGet("/{designId:guid}/versions/{versionId:guid}/svg", SvgAsync);
        group.MapPost("/{designId:guid}/versions/{versionId:guid}/approve", ApproveAsync);
        group.MapPost("/{designId:guid}/versions/{versionId:guid}/reject", RejectAsync);
        group.MapPost("/{designId:guid}/revert", RevertAsync);
        group.MapPost("/{designId:guid}/exclude", ExcludeAsync);
        group.MapPost("/{designId:guid}/include", IncludeAsync);
        group.MapPost("/{designId:guid}/request-better-source", RequestBetterSourceAsync);
        group.MapPost("/{designId:guid}/resume", ResumeAsync);

        group.MapPost("/{designId:guid}/steps/trim", TrimAsync);
        group.MapPost("/{designId:guid}/steps/crop", CropAsync);
        group.MapPost("/{designId:guid}/steps/upscale", UpscaleAsync);
        group.MapPost("/{designId:guid}/steps/resize", ResizeAsync);
        group.MapPost("/{designId:guid}/steps/background-removal", BackgroundRemovalAsync);
    }

    private static async Task<IResult> GetAsync(
        Guid designId,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var found = await designs.FindAsync(designId, cancellationToken);
        return found is null
            ? ApiResults.Problem(ErrorCodes.DesignNotFound, $"Design {designId} was not found.")
            : Results.Ok(found.Value.Design.ToDetail());
    }

    private static async Task<IResult> UpdateAsync(
        Guid designId,
        JsonElement body,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var parsed = ParseUpdate(body);
        if (!parsed.IsSuccess)
        {
            return ApiResults.Problem(parsed.Error!);
        }

        var result = await designs.UpdateAsync(
            designId,
            parsed.Value!,
            "operator",
            cancellationToken);
        return result.IsSuccess
            ? Results.Ok(result.Value.Design.ToDetail())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> SuggestionsAsync(
        Guid designId,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var found = await designs.FindAsync(designId, cancellationToken);
        return found is null
            ? ApiResults.Problem(ErrorCodes.DesignNotFound, $"Design {designId} was not found.")
            : Results.Ok(found.Value.Design.ToSuggestions());
    }

    private static async Task<IResult> VersionsAsync(
        Guid designId,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var found = await designs.FindAsync(designId, cancellationToken);
        return found is null
            ? ApiResults.Problem(ErrorCodes.DesignNotFound, $"Design {designId} was not found.")
            : Results.Ok(found.Value.Design.Versions.Select(version => version.ToDto()).ToList());
    }

    private static async Task<IResult> FileAsync(
        Guid designId,
        Guid versionId,
        int? maxPx,
        HttpRequest request,
        HttpResponse response,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        if (maxPx is < 32 or > 2048)
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "maxPx must be between 32 and 2048.");
        }

        var file = await designs.OpenVersionFileAsync(
            designId,
            versionId,
            maxPx,
            cancellationToken);
        if (!file.IsSuccess)
        {
            return ApiResults.Problem(file.Error!);
        }

        // Version files are immutable, so both the original and any thumbnail
        // may be cached by the browser indefinitely.
        var etag = $"\"{versionId:N}-{(maxPx is null ? "full" : maxPx.Value.ToString())}\"";
        response.Headers.ETag = etag;
        response.Headers.CacheControl = "public, max-age=31536000, immutable";

        if (request.Headers.IfNoneMatch.Contains(etag))
        {
            await file.Value!.Stream.DisposeAsync();
            return Results.StatusCode(StatusCodes.Status304NotModified);
        }

        return Results.Stream(file.Value!.Stream, file.Value.ContentType);
    }

    private static Task<IResult> MaskAsync(
        Guid designId,
        Guid versionId,
        DesignService designs,
        CancellationToken cancellationToken)
        => ServeAsync(designId, versionId, "mask", designs, cancellationToken);

    private static Task<IResult> SvgAsync(
        Guid designId,
        Guid versionId,
        DesignService designs,
        CancellationToken cancellationToken)
        => ServeAsync(designId, versionId, "svg", designs, cancellationToken);

    private static async Task<IResult> ServeAsync(
        Guid designId,
        Guid versionId,
        string artifact,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var file = await designs.OpenArtifactAsync(designId, versionId, artifact, cancellationToken);

        return file.IsSuccess
            ? Results.Stream(file.Value!.Stream, file.Value.ContentType)
            : ApiResults.Problem(file.Error!);
    }

    private static async Task<IResult> ApproveAsync(
        Guid designId,
        Guid versionId,
        VersionService versions,
        CancellationToken cancellationToken)
    {
        var result = await versions.ApproveAsync(designId, versionId, "operator", cancellationToken);
        return result.IsSuccess
            ? Results.Ok(result.Value.Design.ToDetail())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> RejectAsync(
        Guid designId,
        Guid versionId,
        RejectVersionRequest? request,
        VersionService versions,
        CancellationToken cancellationToken)
    {
        var result = await versions.RejectAsync(
            designId,
            versionId,
            request?.Reason,
            "operator",
            cancellationToken);

        return result.IsSuccess
            ? Results.Ok(new RejectVersionResponseDto(
                result.Value.Design.ToDetail(),
                RejectNextActions))
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> RevertAsync(
        Guid designId,
        RevertVersionRequest request,
        VersionService versions,
        CancellationToken cancellationToken)
    {
        var result = await versions.RevertAsync(
            designId,
            request.VersionId,
            "operator",
            cancellationToken);
        return result.IsSuccess
            ? Results.Ok(result.Value.Design.ToDetail())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> ExcludeAsync(
        Guid designId,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var result = await designs.ExcludeAsync(designId, "operator", cancellationToken);
        return await StatusResultAsync(designId, designs, result, cancellationToken);
    }

    private static async Task<IResult> IncludeAsync(
        Guid designId,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var result = await designs.IncludeAsync(designId, "operator", cancellationToken);
        return await StatusResultAsync(designId, designs, result, cancellationToken);
    }

    private static async Task<IResult> RequestBetterSourceAsync(
        Guid designId,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var result = await designs.RequestBetterSourceAsync(designId, "operator", cancellationToken);
        return await StatusResultAsync(designId, designs, result, cancellationToken);
    }

    private static async Task<IResult> ResumeAsync(
        Guid designId,
        DesignService designs,
        CancellationToken cancellationToken)
    {
        var result = await designs.ResumeAsync(designId, "operator", cancellationToken);
        return await StatusResultAsync(designId, designs, result, cancellationToken);
    }

    private static async Task<IResult> StatusResultAsync(
        Guid designId,
        DesignService designs,
        Result result,
        CancellationToken cancellationToken)
    {
        if (!result.IsSuccess)
        {
            return ApiResults.Problem(result.Error!);
        }

        var found = await designs.FindAsync(designId, cancellationToken);
        return found is null
            ? ApiResults.Problem(ErrorCodes.DesignNotFound, $"Design {designId} was not found.")
            : Results.Ok(found.Value.Design.ToDetail());
    }

    private static async Task<IResult> TrimAsync(
        Guid designId,
        TrimStepRequest request,
        StepService steps,
        CancellationToken cancellationToken)
    {
        Result<CropRect> crop = default;
        CropRect? cropRect = null;
        if (request.CropRect is not null)
        {
            crop = CropRect.Create(
                request.CropRect.X,
                request.CropRect.Y,
                request.CropRect.Width,
                request.CropRect.Height);
            if (!crop.IsSuccess)
            {
                return ApiResults.Problem(crop.Error!);
            }

            cropRect = crop.Value;
        }

        var result = await steps.ProposeTrimAsync(
            designId,
            new TrimStepCommand(
                request.Mode,
                request.PaddingPx,
                request.Tolerance,
                cropRect,
                request.BackgroundSample is null
                    ? null
                    : new BackgroundSampleCommand(
                        request.BackgroundSample.Kind ?? "transparent",
                        request.BackgroundSample.Hex,
                        request.BackgroundSample.AlphaThreshold)),
            cancellationToken);

        return result.IsSuccess
            ? Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> CropAsync(
        Guid designId,
        CropStepRequest request,
        StepService steps,
        CancellationToken cancellationToken)
    {
        if (request.Rect is null)
        {
            return ApiResults.Problem(ErrorCodes.InvalidRequest, "A crop rectangle is required.");
        }

        var crop = CropRect.Create(
            request.Rect.X,
            request.Rect.Y,
            request.Rect.Width,
            request.Rect.Height);
        if (!crop.IsSuccess)
        {
            return ApiResults.Problem(crop.Error!);
        }

        var result = await steps.ProposeCropAsync(
            designId,
            new CropStepCommand(crop.Value!),
            cancellationToken);
        return result.IsSuccess
            ? Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> UpscaleAsync(
        Guid designId,
        UpscaleStepRequest request,
        StepService steps,
        CancellationToken cancellationToken)
    {
        var result = await steps.ProposeUpscaleAsync(
            designId,
            new UpscaleStepCommand(
                request.Model,
                request.Scale,
                request.TileSize,
                request.Gpu ?? true),
            cancellationToken);
        return result.IsSuccess
            ? Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> BackgroundRemovalAsync(
        Guid designId,
        BackgroundRemovalStepRequest request,
        StepService steps,
        CancellationToken cancellationToken)
    {
        var result = await steps.ProposeBackgroundRemovalAsync(
            designId,
            new BackgroundRemovalStepCommand(
                request.Mode,
                request.KeyColor,
                request.Tolerance,
                request.EdgeSoftness,
                request.AiModel,
                request.BrushOps?
                    .Select(op => new BrushOpCommand(
                        op.Tool,
                        op.RadiusPx,
                        (op.Points ?? [])
                            .Select(point => new BrushPointCommand(point[0], point[1]))
                            .ToArray()))
                    .ToArray()),
            cancellationToken);
        return result.IsSuccess
            ? Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> ResizeAsync(
        Guid designId,
        ResizeStepRequest request,
        StepService steps,
        CancellationToken cancellationToken)
    {        var result = await steps.ProposeResizeAsync(
            designId,
            new ResizeStepCommand(
                request.TargetWidthCm,
                request.TargetHeightCm,
                request.FitMode,
                request.Dpi),
            cancellationToken);
        return result.IsSuccess
            ? Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static IResult Accepted(Application.Jobs.JobAccepted accepted)
        => Results.Accepted(
            $"/api/v1/jobs/{accepted.JobId}",
            new JobAcceptedDto(
                accepted.JobId,
                accepted.Status.ToContract(),
                $"/api/v1/jobs/{accepted.JobId}"));

    private static Result<UpdateDesignCommand> ParseUpdate(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object)
        {
            return Result<UpdateDesignCommand>.Failure(
                ErrorCodes.InvalidRequest,
                "The request body must be a JSON object.");
        }

        var name = Optional<string>.Unset;
        if (body.TryGetProperty("name", out var nameElement))
        {
            if (nameElement.ValueKind != JsonValueKind.String)
            {
                return Invalid("name must be a string.");
            }

            name = Optional<string>.Set(nameElement.GetString());
        }

        var garmentColor = Optional<GarmentColor>.Unset;
        if (body.TryGetProperty("garmentColor", out var colorElement))
        {
            if (colorElement.ValueKind != JsonValueKind.Object
                || !colorElement.TryGetProperty("kind", out var kindElement)
                || !ApiResults.TryParseGarmentColorKind(kindElement.GetString(), out var kind))
            {
                return Invalid("garmentColor.kind must be light, dark or custom.");
            }

            var hex = colorElement.TryGetProperty("hex", out var hexElement)
                      && hexElement.ValueKind == JsonValueKind.String
                ? hexElement.GetString()
                : null;
            var created = GarmentColor.Create(kind, hex);
            if (!created.IsSuccess)
            {
                return Result<UpdateDesignCommand>.Failure(created.Error!);
            }

            garmentColor = Optional<GarmentColor>.Set(created.Value!);
        }

        var allowRotation = Optional<bool>.Unset;
        if (body.TryGetProperty("allowRotation", out var rotationElement))
        {
            if (rotationElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                return Invalid("allowRotation must be a boolean.");
            }

            allowRotation = Optional<bool>.Set(rotationElement.GetBoolean());
        }

        var targetWidth = Optional<decimal?>.Unset;
        if (body.TryGetProperty("targetWidthCm", out var widthElement))
        {
            var parsed = ParseNullableDecimal(widthElement, "targetWidthCm");
            if (!parsed.IsSuccess)
            {
                return Result<UpdateDesignCommand>.Failure(parsed.Error!);
            }

            targetWidth = Optional<decimal?>.Set(parsed.Value);
        }

        var targetHeight = Optional<decimal?>.Unset;
        if (body.TryGetProperty("targetHeightCm", out var heightElement))
        {
            var parsed = ParseNullableDecimal(heightElement, "targetHeightCm");
            if (!parsed.IsSuccess)
            {
                return Result<UpdateDesignCommand>.Failure(parsed.Error!);
            }

            targetHeight = Optional<decimal?>.Set(parsed.Value);
        }

        var notes = Optional<string?>.Unset;
        if (body.TryGetProperty("notes", out var notesElement))
        {
            if (notesElement.ValueKind == JsonValueKind.Null)
            {
                notes = Optional<string?>.Set(null);
            }
            else if (notesElement.ValueKind == JsonValueKind.String)
            {
                notes = Optional<string?>.Set(notesElement.GetString());
            }
            else
            {
                return Invalid("notes must be a string or null.");
            }
        }

        return Result<UpdateDesignCommand>.Success(new UpdateDesignCommand(
            name,
            garmentColor,
            allowRotation,
            targetWidth,
            targetHeight,
            notes));

        static Result<UpdateDesignCommand> Invalid(string message)
            => Result<UpdateDesignCommand>.Failure(ErrorCodes.InvalidRequest, message);
    }

    private static Result<decimal?> ParseNullableDecimal(JsonElement element, string field)
    {
        if (element.ValueKind == JsonValueKind.Null)
        {
            return Result<decimal?>.Success(null);
        }

        if (element.ValueKind == JsonValueKind.Number && element.TryGetDecimal(out var value))
        {
            return Result<decimal?>.Success(value);
        }

        return Result<decimal?>.Failure(
            ErrorCodes.InvalidRequest,
            $"{field} must be a number or null.");
    }
}
