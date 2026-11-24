using System.Globalization;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Preflight;
using PrintSheet.Domain.Units;

namespace PrintSheet.Infrastructure.Preflight.Checks;

/// <summary>
/// Effective print resolution: the pixels the version actually has across the
/// printed width. The design's working DPI says what the packer expects; this
/// says what the artwork can deliver.
/// </summary>
public sealed class ResolutionCheck : IPreflightCheck
{
    public string Code => "resolution";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var spec = context.Spec;
        var profile = context.Profile;
        var dpi = Math.Min(
            PrintUnits.EffectiveDpi(context.Image.Width, spec.WidthCm),
            PrintUnits.EffectiveDpi(context.Image.Height, spec.HeightCm));

        var metrics = new[]
        {
            PreflightSupport.Metric("effective-dpi", (double)dpi, "dpi"),
            PreflightSupport.Metric("width-px", context.Image.Width, "px"),
            PreflightSupport.Metric("height-px", context.Image.Height, "px"),
        };

        // Pixel rounding makes an exact 300 DPI target land at 299.97; judging that
        // as "below target" would warn on every correctly sized version.
        var effective = (double)dpi;
        if (effective < profile.MinimumDpi - 0.5)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Error,
                    "Resolution too low",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"The version prints at {dpi:F0} DPI; the minimum is {profile.MinimumDpi} DPI. Upscale or reduce the print size."),
                    null,
                    metrics),
                metrics);
        }

        if (effective < profile.RecommendedDpi - 0.5)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "Resolution below target",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"The version prints at {dpi:F0} DPI; {profile.RecommendedDpi} DPI is the shop target."),
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>A cut-out without transparency is a rectangle of background on the shirt.</summary>
public sealed class AlphaCheck : IPreflightCheck
{
    public string Code => "alpha";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var image = context.Image;
        var transparent = image.PixelCount - context.Analysis.ForegroundPixels;
        var fraction = (double)transparent / image.PixelCount;
        var metrics = new[]
        {
            PreflightSupport.Metric("transparent-fraction", fraction, "fraction"),
            PreflightSupport.Metric("transparent-px", transparent, "px"),
        };

        if (!image.HasAlphaChannel || transparent == 0)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Error,
                    "No transparency",
                    image.HasAlphaChannel
                        ? "Every pixel is opaque, so the background will print."
                        : "The PNG has no alpha channel, so the background will print.",
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>8 bits per channel is what the RIP expects; 16-bit files are silently reduced.</summary>
public sealed class BitDepthCheck : IPreflightCheck
{
    public string Code => "bit-depth";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var metrics = new[] { PreflightSupport.Metric("bit-depth", context.Image.BitDepth, "bit") };
        if (context.Image.BitDepth > 8)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "High bit depth",
                    $"{context.Image.BitDepth}-bit input will be reduced to 8-bit by the print pipeline.",
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>A missing colour profile means the RIP guesses the colour space.</summary>
public sealed class IccProfileCheck : IPreflightCheck
{
    public string Code => "icc-profile";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        if (!context.Image.HasSrgbProfile)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "No sRGB profile",
                    "The PNG has no sRGB or ICC profile; colours may shift when printed.",
                    null,
                    []));
        }

        return PreflightCheckResult.None;
    }
}

/// <summary>pHYs is advisory, but the packer and the RIP read it.</summary>
public sealed class DpiMetadataCheck : IPreflightCheck
{
    public string Code => "dpi-metadata";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var image = context.Image;
        var spec = context.Spec;

        if (image.DpiX is not { } dpiX || image.DpiY is not { } dpiY)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "Missing DPI metadata",
                    $"The PNG does not declare its resolution; the print size assumes {spec.Dpi} DPI.",
                    null,
                    []),
                PreflightSupport.Metric("metadata-dpi", 0, "dpi", $"{spec.Dpi} dpi"));
        }

        var metrics = new[]
        {
            PreflightSupport.Metric("metadata-dpi", dpiX, "dpi", $"{spec.Dpi} dpi"),
        };

        if (Math.Abs(dpiX - spec.Dpi) > 1 || Math.Abs(dpiY - spec.Dpi) > 1)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "DPI metadata mismatch",
                    $"The PNG declares {dpiX}x{dpiY} DPI; the print spec is {spec.Dpi} DPI.",
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}
