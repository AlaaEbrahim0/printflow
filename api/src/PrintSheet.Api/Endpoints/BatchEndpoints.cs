using PrintSheet.Api.Contracts;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Services;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Api.Endpoints;

public static class BatchEndpoints
{
    public static void MapBatchEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/batches").WithTags("Batches");

        group.MapGet("/", ListAsync);
        group.MapPost("/", CreateAsync);
        group.MapGet("/{batchId:guid}", GetAsync);
        group.MapPatch("/{batchId:guid}", UpdateAsync);
        group.MapPost("/{batchId:guid}/designs", UploadAsync).DisableAntiforgery();
    }

    private static async Task<IResult> ListAsync(
        BatchService batches,
        string? status,
        int limit = 20,
        int offset = 0,
        CancellationToken cancellationToken = default)
    {
        BatchStatus? parsedStatus = null;
        if (!string.IsNullOrWhiteSpace(status))
        {
            if (!ApiResults.TryParseBatchStatus(status, out var value))
            {
                return ApiResults.Problem(ErrorCodes.InvalidRequest, $"Unknown batch status '{status}'.");
            }

            parsedStatus = value;
        }

        if (limit is < 1 or > 100)
        {
            return ApiResults.Problem(ErrorCodes.InvalidRequest, "limit must be between 1 and 100.");
        }

        if (offset < 0)
        {
            return ApiResults.Problem(ErrorCodes.InvalidRequest, "offset must not be negative.");
        }

        var (items, total) = await batches.ListAsync(parsedStatus, limit, offset, cancellationToken);
        var payload = new BatchListDto(
            items.Select(batch => batch.ToSummary(batch.CurrentSheet)).ToList(),
            total);
        return Results.Ok(payload);
    }

    private static async Task<IResult> CreateAsync(
        CreateBatchRequest request,
        BatchService batches,
        CancellationToken cancellationToken)
    {
        var result = await batches.CreateAsync(
            new CreateBatchCommand(
                request.Name,
                request.RollWidthCm,
                request.MarginMm,
                request.EdgeMarginMm,
                request.WorkingDpi),
            cancellationToken);

        return result.IsSuccess
            ? Results.Created($"/api/v1/batches/{result.Value!.Id}", result.Value.ToDetail())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> GetAsync(
        Guid batchId,
        BatchService batches,
        CancellationToken cancellationToken)
    {
        var batch = await batches.GetAsync(batchId, cancellationToken);
        return batch is null
            ? ApiResults.Problem(ErrorCodes.BatchNotFound, $"Batch {batchId} was not found.")
            : Results.Ok(batch.ToDetail());
    }

    private static async Task<IResult> UpdateAsync(
        Guid batchId,
        UpdateBatchRequest request,
        BatchService batches,
        CancellationToken cancellationToken)
    {
        var result = await batches.UpdateAsync(
            batchId,
            new UpdateBatchCommand(
                request.Name,
                request.RollWidthCm,
                request.MarginMm,
                request.EdgeMarginMm),
            "operator",
            cancellationToken);

        return result.IsSuccess
            ? Results.Ok(result.Value!.ToDetail())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> UploadAsync(
        Guid batchId,
        HttpRequest request,
        IntakeService intake,
        CancellationToken cancellationToken)
    {
        if (!request.HasFormContentType)
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "The upload must be multipart/form-data with a 'file' field.");
        }

        var form = await request.ReadFormAsync(cancellationToken);
        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0)
        {
            return ApiResults.Problem(
                ErrorCodes.UnsupportedImage,
                "The 'file' field is required and must not be empty.");
        }

        var kind = GarmentColorKind.Light;
        var kindRaw = form["garmentColorKind"].ToString();
        if (!string.IsNullOrWhiteSpace(kindRaw)
            && !ApiResults.TryParseGarmentColorKind(kindRaw, out kind))
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "garmentColorKind must be light, dark or custom.");
        }

        if (!RequestParsing.TryGetDecimal(form, "targetWidthCm", out var targetWidthCm)
            || !RequestParsing.TryGetDecimal(form, "targetHeightCm", out var targetHeightCm))
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidTargetSize,
                "Target width and height must be decimal centimetres.");
        }

        var readyToPack = false;
        var readyRaw = form["readyToPack"].ToString();
        if (!string.IsNullOrWhiteSpace(readyRaw))
        {
            if (readyRaw.Equals("true", StringComparison.OrdinalIgnoreCase) || readyRaw == "1")
            {
                readyToPack = true;
            }
            else if (!readyRaw.Equals("false", StringComparison.OrdinalIgnoreCase) && readyRaw != "0")
            {
                return ApiResults.Problem(
                    ErrorCodes.InvalidRequest,
                    "readyToPack must be true or false.");
            }
        }

        if (targetWidthCm.HasValue != targetHeightCm.HasValue)
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidTargetSize,
                readyToPack
                    ? "Provide both target dimensions or neither; ready-to-pack imports derive them from pixels."
                    : "Provide both target dimensions or neither.");
        }

        await using var stream = file.OpenReadStream();
        var command = new UploadDesignCommand(
            stream,
            file.Length,
            file.FileName,
            form["name"].ToString(),
            kind,
            form["garmentColorHex"].ToString(),
            targetWidthCm,
            targetHeightCm,
            readyToPack);

        var result = await intake.UploadAsync(batchId, command, "operator", cancellationToken);
        if (!result.IsSuccess)
        {
            return ApiResults.Problem(result.Error!);
        }

        var (_, design) = result.Value;
        return Results.Created($"/api/v1/designs/{design.Id}", design.ToDetail());
    }
}
