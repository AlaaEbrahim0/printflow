namespace PrintSheet.Domain.Units;

/// <summary>
/// Physical-unit and pixel conversion rules shared by the domain, worker
/// contracts and the packer. Sizes are always stored in both physical units
/// (centimetres) and pixels at an explicit working DPI.
/// </summary>
public static class PrintUnits
{
    public const decimal CentimetersPerInch = 2.54m;
    public const int DefaultWorkingDpi = 300;

    /// <summary>
    /// Converts centimetres to whole pixels using round-half-away-from-zero.
    /// At 58 cm and 300 DPI this yields the 6850 px roll width used by the
    /// packer fixtures and specifications.
    /// </summary>
    public static int PixelsForCentimeters(decimal centimeters, int dpi)
    {
        if (centimeters <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(centimeters), "Length must be positive.");
        }

        if (dpi <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(dpi), "DPI must be positive.");
        }

        return (int)decimal.Round(
            centimeters * dpi / CentimetersPerInch,
            0,
            MidpointRounding.AwayFromZero);
    }

    public static decimal CentimetersForPixels(int pixels, int dpi)
    {
        if (pixels <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(pixels), "Pixel count must be positive.");
        }

        if (dpi <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(dpi), "DPI must be positive.");
        }

        return pixels * CentimetersPerInch / dpi;
    }

    /// <summary>
    /// Effective source resolution when <paramref name="pixels"/> source pixels
    /// are printed across <paramref name="centimeters"/>.
    /// </summary>
    public static decimal EffectiveDpi(int pixels, decimal centimeters)
    {
        if (pixels <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(pixels), "Pixel count must be positive.");
        }

        if (centimeters <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(centimeters), "Length must be positive.");
        }

        return pixels * CentimetersPerInch / centimeters;
    }

    public static decimal MillimetersToCentimeters(decimal millimeters) => millimeters / 10m;
}
