using System.Text.Json;
using Microsoft.Extensions.Options;
using PrintSheet.Api.Contracts;
using PrintSheet.Application.Preflight;
using PrintSheet.Application.Services;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Preflight;
using PrintSheet.Domain.Units;

namespace PrintSheet.Api.Endpoints;

/// <summary>
/// Ad-hoc preflight for a file that is not a version yet: the operator uploads
/// the PNG a designer sent and gets the same report the cut-out writes. Report
/// only unless <c>fix=true</c>, which returns the repaired PNG as base64 beside
/// the report.
/// </summary>
public static class PreflightEndpoints
{
    public static void MapPreflightEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/preflight", PreflightAsync)
            .WithTags("Preflight")
            .DisableAntiforgery();
    }

    private static async Task<IResult> PreflightAsync(
        HttpRequest request,
        PreflightService preflight,
        IOptions<IntakeOptions> intake,
        CancellationToken cancellationToken)
    {
        if (!preflight.Enabled)
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "Preflight is disabled on this deployment.");
        }

        if (!request.HasFormContentType)
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "The request must be multipart/form-data with a 'file' field.");
        }

        IFormCollection form;
        try
        {
            form = await request.ReadFormAsync(cancellationToken);
        }
        catch (InvalidDataException exception)
        {
            // A malformed body is the caller's problem, not a server fault: the
            // framework throws here rather than reporting a missing file.
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                $"The multipart body could not be read: {exception.Message}");
        }

        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0)
        {
            return ApiResults.Problem(
                ErrorCodes.UnsupportedImage,
                "The 'file' field is required and must not be empty.");
        }

        if (file.Length > intake.Value.MaxUploadBytes)
        {
            return ApiResults.Problem(
                ErrorCodes.UploadTooLarge,
                $"The upload exceeds the {intake.Value.MaxUploadBytes} byte limit.");
        }

        var garmentKind = GarmentColorKind.Light;
        var kindRaw = form["garmentColorKind"].ToString();
        if (!string.IsNullOrWhiteSpace(kindRaw)
            && !ApiResults.TryParseGarmentColorKind(kindRaw, out garmentKind))
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "garmentColorKind must be light, dark or custom.");
        }

        var garment = GarmentColor.Create(garmentKind, form["garmentColorHex"].ToString());
        if (!garment.IsSuccess)
        {
            return ApiResults.Problem(garment.Error!);
        }

        var dpi = PrintUnits.DefaultWorkingDpi;
        if (!RequestParsing.TryGetInt(form, "dpi", out var requestedDpi))
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidTargetSize,
                "dpi must be a whole number.");
        }

        if (requestedDpi is { } explicitDpi)
        {
            if (explicitDpi is < PrintSpec.MinimumDpi or > PrintSpec.MaximumDpi)
            {
                return ApiResults.Problem(
                    ErrorCodes.InvalidTargetSize,
                    $"dpi must be between {PrintSpec.MinimumDpi} and {PrintSpec.MaximumDpi}.");
            }

            dpi = explicitDpi;
        }

        PrintSpec? spec = null;
        if (RequestParsing.TryGetDecimal(form, "targetWidthCm", out var widthCm)
            && RequestParsing.TryGetDecimal(form, "targetHeightCm", out var heightCm))
        {
            if (widthCm.HasValue != heightCm.HasValue)
            {
                return ApiResults.Problem(
                    ErrorCodes.InvalidTargetSize,
                    "Provide both target dimensions or neither.");
            }

            if (widthCm is { } width && heightCm is { } height)
            {
                var created = PrintSpec.Create(width, height, dpi, garment.Value!);
                if (!created.IsSuccess)
                {
                    return ApiResults.Problem(created.Error!);
                }

                spec = created.Value;
            }
        }
        else
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidTargetSize,
                "Target width and height must be decimal centimetres.");
        }

        var fix = false;
        var fixRaw = form["fix"].ToString();
        if (!string.IsNullOrWhiteSpace(fixRaw))
        {
            if (fixRaw.Equals("true", StringComparison.OrdinalIgnoreCase) || fixRaw == "1")
            {
                fix = true;
            }
            else if (!fixRaw.Equals("false", StringComparison.OrdinalIgnoreCase) && fixRaw != "0")
            {
                return ApiResults.Problem(
                    ErrorCodes.InvalidRequest,
                    "fix must be true or false.");
            }
        }

        byte[] bytes;
        await using (var stream = file.OpenReadStream())
        {
            using var buffer = new MemoryStream();
            await stream.CopyToAsync(buffer, cancellationToken);
            bytes = buffer.ToArray();
        }

        try
        {
            var outcome = preflight.Run(
                bytes,
                spec,
                dpi,
                garment.Value!,
                form["profile"].ToString(),
                fix,
                cancellationToken);

            if (!outcome.IsSuccess)
            {
                return ApiResults.Problem(outcome.Error!);
            }

            using var report = JsonDocument.Parse(outcome.Value!.Json);
            return Results.Ok(
                new PreflightResponseDto(
                    report.RootElement.Clone(),
                    outcome.Value.FixedPng is { } fixedPng
                        ? Convert.ToBase64String(fixedPng)
                        : null));
        }
        catch (PreflightException exception)
        {
            return ApiResults.Problem(exception.Code, exception.Message);
        }
    }
}
