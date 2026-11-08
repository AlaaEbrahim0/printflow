using PrintSheet.Domain.Common;
using PrintSheet.Domain.Units;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// Batch geometry snapshotted at creation. Changing global settings never
/// rewrites an existing batch.
/// </summary>
public sealed record BatchGeometry
{
    public const decimal DefaultRollWidthCm = 58m;
    public const decimal DefaultMarginMm = 30m;
    public const decimal DefaultEdgeMarginMm = 0m;
    public const int DefaultWorkingDpi = PrintUnits.DefaultWorkingDpi;

    private BatchGeometry(decimal rollWidthCm, decimal marginMm, decimal edgeMarginMm, int workingDpi)
    {
        RollWidthCm = rollWidthCm;
        MarginMm = marginMm;
        EdgeMarginMm = edgeMarginMm;
        WorkingDpi = workingDpi;
    }

    /// <summary>For EF Core materialisation only.</summary>
    private BatchGeometry()
    {
    }

    public decimal RollWidthCm { get; }

    public decimal MarginMm { get; }

    public decimal EdgeMarginMm { get; }

    public int WorkingDpi { get; }

    public decimal UsableWidthCm => RollWidthCm - (2 * EdgeMarginMm / 10m);

    public int RollWidthPx => PrintUnits.PixelsForCentimeters(RollWidthCm, WorkingDpi);

    public int MarginPx => (int)decimal.Ceiling(MarginMm / 10m * WorkingDpi / 2.54m);

    public bool SameAs(BatchGeometry other)
        => RollWidthCm == other.RollWidthCm
           && MarginMm == other.MarginMm
           && EdgeMarginMm == other.EdgeMarginMm
           && WorkingDpi == other.WorkingDpi;

    public static Result<BatchGeometry> Create(
        decimal rollWidthCm,
        decimal marginMm,
        decimal edgeMarginMm,
        int workingDpi)
    {
        if (rollWidthCm is < 1m or > 500m)
        {
            return Result<BatchGeometry>.Failure(
                ErrorCodes.InvalidRequest,
                "Roll width must be between 1 and 500 cm.");
        }

        if (marginMm is < 0m or > 500m)
        {
            return Result<BatchGeometry>.Failure(
                ErrorCodes.InvalidRequest,
                "Margin must be between 0 and 500 mm.");
        }

        if (edgeMarginMm is < 0m or > 500m)
        {
            return Result<BatchGeometry>.Failure(
                ErrorCodes.InvalidRequest,
                "Edge margin must be between 0 and 500 mm.");
        }

        if (workingDpi is < 72 or > 1200)
        {
            return Result<BatchGeometry>.Failure(
                ErrorCodes.InvalidRequest,
                "Working DPI must be between 72 and 1200.");
        }

        if (edgeMarginMm * 2 / 10m >= rollWidthCm)
        {
            return Result<BatchGeometry>.Failure(
                ErrorCodes.InvalidRequest,
                "Edge margins leave no usable roll width.");
        }

        return Result<BatchGeometry>.Success(
            new BatchGeometry(rollWidthCm, marginMm, edgeMarginMm, workingDpi));
    }

    public static BatchGeometry Default => new(
        DefaultRollWidthCm,
        DefaultMarginMm,
        DefaultEdgeMarginMm,
        DefaultWorkingDpi);
}
