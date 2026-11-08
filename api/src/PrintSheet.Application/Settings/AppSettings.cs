using PrintSheet.Domain.Common;

namespace PrintSheet.Application.Settings;

/// <summary>Global defaults. Batch geometry is snapshotted, so editing these never rewrites a batch.</summary>
public sealed record AppSettings(
    int WorkingDpi,
    decimal DefaultRollWidthCm,
    decimal DefaultMarginMm,
    decimal DefaultEdgeMarginMm,
    int DpiWarnBelow,
    int DpiStrongWarnBelow,
    decimal PricePerCm,
    string Currency,
    PackerSettings Packer)
{
    public static AppSettings Default => new(
        WorkingDpi: 300,
        DefaultRollWidthCm: 58m,
        DefaultMarginMm: 30m,
        DefaultEdgeMarginMm: 0m,
        DpiWarnBelow: 150,
        DpiStrongWarnBelow: 100,
        PricePerCm: 0m,
        Currency: "EUR",
        Packer: PackerSettings.Default);

    public Result Validate()
    {
        if (WorkingDpi is < 72 or > 1200)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Working DPI must be between 72 and 1200.");
        }

        if (DefaultRollWidthCm is < 1m or > 500m)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Default roll width is out of range.");
        }

        if (DefaultMarginMm is < 0m or > 500m || DefaultEdgeMarginMm is < 0m or > 500m)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Default margins are out of range.");
        }

        if (DpiWarnBelow < 1 || DpiStrongWarnBelow < 1)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "DPI warning thresholds must be positive.");
        }

        if (DpiStrongWarnBelow > DpiWarnBelow)
        {
            return Result.Failure(
                ErrorCodes.InvalidRequest,
                "The strong DPI warning must be at or below the normal warning threshold.");
        }

        if (PricePerCm < 0m)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Price per centimetre must not be negative.");
        }

        if (string.IsNullOrWhiteSpace(Currency) || Currency.Length != 3)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Currency must be a three-letter code.");
        }

        return Packer.Validate();
    }

    public decimal EstimatedCost(decimal sheetHeightCm) => PricePerCm * sheetHeightCm;
}

public sealed record PackerSettings(
    int AlphaThreshold,
    decimal CellMm,
    int RandomizedOrderings,
    int TimeBudgetMs)
{
    public static PackerSettings Default => new(
        AlphaThreshold: 5,
        CellMm: 2m,
        RandomizedOrderings: 40,
        TimeBudgetMs: 5000);

    public Result Validate()
    {
        if (AlphaThreshold is < 0 or > 254)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Alpha threshold must be between 0 and 254.");
        }

        if (CellMm is < 0.1m or > 50m)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Occupancy cell size must be between 0.1 and 50 mm.");
        }

        if (RandomizedOrderings is < 1 or > 1000)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Randomized ordering count is out of range.");
        }

        if (TimeBudgetMs is < 1000 or > 600000)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Packer time budget is out of range.");
        }

        return Result.Success();
    }
}
