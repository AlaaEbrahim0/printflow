using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Infrastructure.Preflight;

/// <summary>Shared colour math and metric formatting for the checks.</summary>
internal static class PreflightSupport
{
    public static PreflightMetric Metric(string name, double value, string unit, string? limit = null)
        => new(name, (decimal)Math.Round(value, 4), unit, limit);

    /// <summary>Light and dark are the two garment colours the shop actually stocks.</summary>
    public static (byte R, byte G, byte B) GarmentRgb(GarmentColor garment)
        => garment.Kind switch
        {
            GarmentColorKind.Dark => (0, 0, 0),
            GarmentColorKind.Custom when garment.Hex is { Length: 7 } hex => ParseHex(hex),
            _ => (255, 255, 255),
        };

    public static string Hex(byte r, byte g, byte b) => $"#{r:X2}{g:X2}{b:X2}";

    public static (byte R, byte G, byte B) Blend(
        (byte R, byte G, byte B) ink,
        (byte R, byte G, byte B) garment,
        double opacity)
        => (
            (byte)Math.Clamp(Math.Round((ink.R * opacity) + (garment.R * (1 - opacity))), 0, 255),
            (byte)Math.Clamp(Math.Round((ink.G * opacity) + (garment.G * (1 - opacity))), 0, 255),
            (byte)Math.Clamp(Math.Round((ink.B * opacity) + (garment.B * (1 - opacity))), 0, 255));

    /// <summary>WCAG 2.1 relative luminance and contrast ratio.</summary>
    public static double ContrastRatio(
        (byte R, byte G, byte B) first,
        (byte R, byte G, byte B) second)
    {
        var a = Luminance(first);
        var b = Luminance(second);
        return (Math.Max(a, b) + 0.05) / (Math.Min(a, b) + 0.05);
    }

    private static double Luminance((byte R, byte G, byte B) color)
        => (0.2126 * Channel(color.R)) + (0.7152 * Channel(color.G)) + (0.0722 * Channel(color.B));

    private static double Channel(byte value)
    {
        var channel = value / 255d;
        return channel <= 0.03928
            ? channel / 12.92
            : Math.Pow((channel + 0.055) / 1.055, 2.4);
    }

    private static (byte R, byte G, byte B) ParseHex(string hex)
        => (
            byte.Parse(hex.AsSpan(1, 2), System.Globalization.NumberStyles.HexNumber),
            byte.Parse(hex.AsSpan(3, 2), System.Globalization.NumberStyles.HexNumber),
            byte.Parse(hex.AsSpan(5, 2), System.Globalization.NumberStyles.HexNumber));
}
