using PrintSheet.Api.Contracts;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Jobs;
using PrintSheet.Application.Services;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;

namespace PrintSheet.Api.Endpoints;

public static class SheetEndpoints
{
    public static void MapSheetEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/batches/{batchId:guid}").WithTags("Sheet");

        group.MapGet("/sheet", GetAsync);
        group.MapPost("/sheet/pack", PackAsync);
        group.MapPut("/sheet/placements", UpdatePlacementsAsync);
        group.MapPost("/sheet/integrity-check", IntegrityAsync);
        group.MapGet("/sheet/preview", PreviewAsync);
    }

    private static async Task<IResult> GetAsync(
        Guid batchId,
        SheetService sheets,
        CancellationToken cancellationToken)
    {
        var result = await sheets.GetCurrentSheetAsync(batchId, cancellationToken);
        return result.IsSuccess
            ? Results.Ok(result.Value!.ToDto())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> PackAsync(
        Guid batchId,
        PackSheetRequest? request,
        SheetService sheets,
        CancellationToken cancellationToken)
    {
        var command = new PackSheetCommand(
            request?.DesignIds,
            request?.Seed,
            request?.RandomizedOrderings,
            request?.TimeBudgetMs,
            request?.NoInterlocking ?? false,
            request?.AlphaThreshold,
            request?.CellMm);

        var result = await sheets.PackAsync(batchId, command, cancellationToken);
        return result.IsSuccess
            ? Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> UpdatePlacementsAsync(
        Guid batchId,
        PlacementsUpdateRequest request,
        SheetService sheets,
        CancellationToken cancellationToken)
    {
        if (request.Placements is null)
        {
            return ApiResults.Problem(ErrorCodes.InvalidRequest, "placements is required.");
        }

        var placements = request.Placements
            .Select(placement => new ManualPlacementCommand(
                placement.DesignId,
                placement.VersionId,
                placement.XCm,
                placement.YCm,
                placement.RotationDeg))
            .ToList();

        var result = await sheets.UpdatePlacementsAsync(
            batchId,
            request.Revision,
            placements,
            "operator",
            cancellationToken);

        return result.IsSuccess
            ? Results.Ok(result.Value!.ToDto())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> IntegrityAsync(
        Guid batchId,
        SheetService sheets,
        CancellationToken cancellationToken)
    {
        var result = await sheets.RunIntegrityCheckAsync(batchId, cancellationToken);
        return result.IsSuccess
            ? Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> PreviewAsync(
        Guid batchId,
        SheetService sheets,
        CancellationToken cancellationToken)
    {
        var result = await sheets.OpenPreviewAsync(batchId, cancellationToken);
        return result.IsSuccess
            ? Results.Stream(result.Value!.Stream, result.Value.ContentType)
            : ApiResults.Problem(result.Error!);
    }

    internal static IResult Accepted(JobAccepted accepted)
        => Results.Accepted(
            $"/api/v1/jobs/{accepted.JobId}",
            new JobAcceptedDto(
                accepted.JobId,
                accepted.Status.ToContract(),
                $"/api/v1/jobs/{accepted.JobId}"));
}

public static class ExportEndpoints
{
    public static void MapExportEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/batches/{batchId:guid}/exports", ListAsync).WithTags("Exports");
        app.MapPost("/api/v1/batches/{batchId:guid}/exports", CreateAsync).WithTags("Exports");
        app.MapGet("/api/v1/exports/{exportId:guid}", GetAsync).WithTags("Exports");
        app.MapGet("/api/v1/exports/{exportId:guid}/download", DownloadAsync).WithTags("Exports");
    }

    private static async Task<IResult> ListAsync(
        Guid batchId,
        ExportService exports,
        CancellationToken cancellationToken)
    {
        var result = await exports.ListAsync(batchId, cancellationToken);
        return result.IsSuccess
            ? Results.Ok(new ExportListDto(result.Value!.Select(export => export.ToDto()).ToList()))
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> CreateAsync(
        Guid batchId,
        ExportRequest request,
        ExportService exports,
        CancellationToken cancellationToken)
    {
        if (!ApiResults.TryParseExportFormat(request.Format, out var format))
        {
            return ApiResults.Problem(
                ErrorCodes.InvalidRequest,
                "format must be flat-png, flat-tiff, layered-psd, layered-psb or psd-bundle.");
        }

        var result = await exports.CreateAsync(
            batchId,
            new CreateExportCommand(format, request.IncludePreview ?? true),
            "operator",
            cancellationToken);

        return result.IsSuccess
            ? SheetEndpoints.Accepted(result.Value!)
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> GetAsync(
        Guid exportId,
        ExportService exports,
        CancellationToken cancellationToken)
    {
        var result = await exports.GetAsync(exportId, cancellationToken);
        return result.IsSuccess
            ? Results.Ok(result.Value!.ToDto())
            : ApiResults.Problem(result.Error!);
    }

    private static async Task<IResult> DownloadAsync(
        Guid exportId,
        string artifact,
        ExportService exports,
        CancellationToken cancellationToken)
    {
        var result = await exports.OpenArtifactAsync(exportId, artifact, cancellationToken);
        return result.IsSuccess
            ? Results.File(
                result.Value!.Stream,
                result.Value.ContentType,
                result.Value.FileName,
                enableRangeProcessing: true)
            : ApiResults.Problem(result.Error!);
    }
}
