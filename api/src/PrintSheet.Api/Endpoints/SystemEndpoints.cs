using PrintSheet.Api.Contracts;
using PrintSheet.Application.Services;
using PrintSheet.Application.Settings;
using PrintSheet.Domain.Common;

namespace PrintSheet.Api.Endpoints;

public static class SystemEndpoints
{
    public static void MapSystemEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/settings", GetSettingsAsync).WithTags("Settings");
        app.MapPut("/api/v1/settings", UpdateSettingsAsync).WithTags("Settings");
    }

    private static async Task<IResult> GetSettingsAsync(
        SettingsService settings,
        CancellationToken cancellationToken)
        => Results.Ok((await settings.GetAsync(cancellationToken)).ToDto());

    private static async Task<IResult> UpdateSettingsAsync(
        AppSettingsDto request,
        SettingsService settings,
        CancellationToken cancellationToken)
    {
        var result = await settings.UpdateAsync(
            new AppSettings(
                request.WorkingDpi,
                request.DefaultRollWidthCm,
                request.DefaultMarginMm,
                request.DefaultEdgeMarginMm,
                request.DpiWarnBelow,
                request.DpiStrongWarnBelow,
                request.PricePerCm,
                request.Currency,
                new PackerSettings(
                    request.Packer?.AlphaThreshold ?? 5,
                    request.Packer?.CellMm ?? 2m,
                    request.Packer?.RandomizedOrderings ?? 40,
                    request.Packer?.TimeBudgetMs ?? 5000)),
            cancellationToken);

        return result.IsSuccess
            ? Results.Ok(result.Value!.ToDto())
            : ApiResults.Problem(result.Error!);
    }

    private static AppSettingsDto ToDto(this AppSettings settings)
        => new(
            settings.WorkingDpi,
            settings.DefaultRollWidthCm,
            settings.DefaultMarginMm,
            settings.DefaultEdgeMarginMm,
            settings.DpiWarnBelow,
            settings.DpiStrongWarnBelow,
            settings.PricePerCm,
            settings.Currency,
            new PackerSettingsDto(
                settings.Packer.AlphaThreshold,
                settings.Packer.CellMm,
                settings.Packer.RandomizedOrderings,
                settings.Packer.TimeBudgetMs));
}
