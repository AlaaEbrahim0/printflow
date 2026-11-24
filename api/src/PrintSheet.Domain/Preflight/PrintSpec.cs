using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Units;

namespace PrintSheet.Domain.Preflight;

/// <summary>
/// The physical print job a version will be printed as: the finished size on the
/// garment, the working resolution and the garment colour. Preflight judges the
/// pixels against this, so a version that looks fine at preview size can still
/// fail because its effective DPI is low or its edge is too soft for the film.
/// </summary>
public sealed record PrintSpec(
    decimal WidthCm,
    decimal HeightCm,
    int Dpi,
    GarmentColor Garment)
{
    public const int MinimumDpi = 72;
    public const int MaximumDpi = 1200;

    public int WidthPx => PrintUnits.PixelsForCentimeters(WidthCm, Dpi);

    public int HeightPx => PrintUnits.PixelsForCentimeters(HeightCm, Dpi);

    public static Result<PrintSpec> Create(
        decimal widthCm,
        decimal heightCm,
        int dpi,
        GarmentColor garment)
    {
        if (widthCm <= 0 || heightCm <= 0)
        {
            return Result<PrintSpec>.Failure(
                ErrorCodes.InvalidTargetSize,
                "Print width and height must be positive centimetres.");
        }

        if (dpi is < MinimumDpi or > MaximumDpi)
        {
            return Result<PrintSpec>.Failure(
                ErrorCodes.InvalidTargetSize,
                $"DPI must be between {MinimumDpi} and {MaximumDpi}.");
        }

        return Result<PrintSpec>.Success(new PrintSpec(widthCm, heightCm, dpi, garment));
    }

    /// <summary>
    /// Derives a spec from the pixels when the operator has not set a print size
    /// yet: the artwork is judged as if printed 1:1 at the given resolution.
    /// </summary>
    public static PrintSpec FromPixels(int widthPx, int heightPx, int dpi, GarmentColor garment)
    {
        if (widthPx <= 0 || heightPx <= 0 || dpi <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(widthPx),
                "Pixel dimensions and DPI must be positive.");
        }

        return new PrintSpec(
            PrintUnits.CentimetersForPixels(widthPx, dpi),
            PrintUnits.CentimetersForPixels(heightPx, dpi),
            dpi,
            garment);
    }
}
