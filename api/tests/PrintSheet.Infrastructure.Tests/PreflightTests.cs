using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Preflight;
using PrintSheet.Infrastructure.Preflight;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

public sealed class PreflightTests
{
    private const int Size = 300;

    [Fact]
    public void DiscoversEveryCheckAndFixWithoutRegistrationLists()
    {
        Assert.Equal(15, Discover<IPreflightCheck>().Count);
        Assert.Equal(5, Discover<IPreflightFix>().Count);
        Assert.Equal(
            Discover<IPreflightCheck>().Select(check => check.Code).Order(StringComparer.Ordinal),
            Discover<IPreflightCheck>().Select(check => check.Code));
    }

    [Fact]
    public void ACleanCutoutOnADarkGarmentPasses()
    {
        var outcome = Run(Cutout(), Spec());

        Assert.Equal(PreflightVerdict.Pass, outcome.Report.Verdict);
        Assert.Empty(outcome.Report.Findings);
    }

    [Fact]
    public void SemiTransparentInteriorIsAnErrorAndTheFixRepairsIt()
    {
        var png = Cutout(interiorAlpha: 100);

        var before = Run(png, Spec());
        var soft = Assert.Single(before.Report.Findings, finding => finding.Code == "soft-interior");
        Assert.Equal(PreflightSeverity.Error, soft.Severity);

        var fixedOutcome = Run(png, Spec(), applyFixes: true);
        Assert.Contains(fixedOutcome.Report.Fixes, fix => fix.Code == PreflightFixCodes.HardenSoftInterior);
        Assert.DoesNotContain(fixedOutcome.Report.Findings, finding => finding.Code == "soft-interior");
        Assert.NotNull(fixedOutcome.FixedPng);
    }

    [Fact]
    public void MetadataFixesWriteSrgbAndPhysChunks()
    {
        var png = PlainPng();
        var spec = Spec();

        var before = Run(png, spec);
        Assert.Contains(before.Report.Findings, finding => finding.Code == "icc-profile");
        Assert.Contains(before.Report.Findings, finding => finding.Code == "dpi-metadata");

        var after = Run(png, spec, applyFixes: true);
        Assert.Contains(after.Report.Fixes, fix => fix.Code == PreflightFixCodes.EmbedSrgb);
        Assert.Contains(after.Report.Fixes, fix => fix.Code == PreflightFixCodes.SetDpiMetadata);

        var decoded = new SkiaPreflightImageCodec().Decode(after.FixedPng!);
        Assert.True(decoded.HasSrgbProfile);
        Assert.Equal(300, decoded.DpiX);
        Assert.Equal(300, decoded.DpiY);
    }

    [Fact]
    public void ReportJsonIsByteStable()
    {
        var first = Run(Cutout(interiorAlpha: 100), Spec());
        var second = Run(Cutout(interiorAlpha: 100), Spec());

        Assert.Equal(first.Json, second.Json);
        using var parsed = JsonDocument.Parse(first.Json);
        Assert.Equal("1.0", parsed.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal("dtf", parsed.RootElement.GetProperty("profile").GetString());
    }

    [Fact]
    public void AThrowingCheckBecomesAWarningAndDoesNotLoseTheOthers()
    {
        var runner = new PreflightRunner(
            [new ThrowingCheck(), new PassingCheck()],
            NullLogger<PreflightRunner>.Instance);

        var image = new PreflightImage(new byte[4], 1, 1, true, 8, true, 300, 300);
        var run = runner.Run(
            image,
            PrintSpec.Create(0.1m, 0.1m, 300, GarmentColor.Dark).Value!,
            new PreflightProfile(),
            CancellationToken.None);

        Assert.Contains(run.Findings, finding => finding.Code == PreflightRunner.CheckFailedCode);
        Assert.Contains(run.Findings, finding => finding.Code == "passing");
    }

    [Fact]
    public void AnIncoherentProfileIsRejectedAtValidation()
    {
        var errors = new PreflightProfile
        {
            MinimumDpi = 300,
            RecommendedDpi = 200,
            CriticalStrokeMm = 0.6,
            MinimumStrokeMm = 0.5,
            MaximumCoverageFraction = 0,
        }.Validate();

        Assert.Contains(errors, error => error.Contains("RecommendedDpi", StringComparison.Ordinal));
        Assert.Contains(errors, error => error.Contains("CriticalStrokeMm", StringComparison.Ordinal));
        Assert.Contains(errors, error => error.Contains("MaximumCoverageFraction", StringComparison.Ordinal));
    }

    private static PreflightOutcome Run(byte[] png, PrintSpec spec, bool applyFixes = false)
    {
        var outcome = Service().Run(
            png,
            spec,
            spec.Dpi,
            spec.Garment,
            profileName: null,
            applyFixes,
            CancellationToken.None);

        Assert.True(outcome.IsSuccess, outcome.Error?.Message);
        return outcome.Value!;
    }

    private static PreflightService Service()
        => new(
            new SkiaPreflightImageCodec(),
            new PreflightRunner(Discover<IPreflightCheck>(), NullLogger<PreflightRunner>.Instance),
            Discover<IPreflightFix>(),
            Options.Create(new PreflightOptions()),
            NullLogger<PreflightService>.Instance);

    private static IReadOnlyList<T> Discover<T>()
        => typeof(SkiaPreflightImageCodec).Assembly
            .GetTypes()
            .Where(type => !type.IsAbstract
                && !type.IsInterface
                && typeof(T).IsAssignableFrom(type))
            .OrderBy(type => type.FullName, StringComparer.Ordinal)
            .Select(type => (T)Activator.CreateInstance(type)!)
            .ToArray();

    /// <summary>2.54 cm at 300 DPI is exactly the 300 px canvas used here.</summary>
    private static PrintSpec Spec()
        => PrintSpec.Create(2.54m, 2.54m, 300, GarmentColor.Dark).Value!;

    /// <summary>A hard-edged white square on a transparent canvas.</summary>
    private static byte[] Cutout(byte? interiorAlpha = null)
    {
        var pixels = new byte[Size * Size * 4];
        for (var y = 100; y < 200; y++)
        {
            for (var x = 100; x < 200; x++)
            {
                var offset = (((y * Size) + x) * 4);
                var alpha = interiorAlpha is { } soft && x is >= 140 and < 160 && y is >= 140 and < 160
                    ? soft
                    : (byte)255;
                pixels[offset] = 255;
                pixels[offset + 1] = 255;
                pixels[offset + 2] = 255;
                pixels[offset + 3] = alpha;
            }
        }

        return new SkiaPreflightImageCodec().Encode(
            new PreflightImage(pixels, Size, Size, true, 8, true, 300, 300));
    }

    /// <summary>A PNG with no sRGB and no pHYs chunk, as a screenshot would arrive.</summary>
    private static byte[] PlainPng()
    {
        var pixels = new byte[Size * Size * 4];
        for (var y = 100; y < 200; y++)
        {
            for (var x = 100; x < 200; x++)
            {
                var offset = (((y * Size) + x) * 4);
                pixels[offset] = 255;
                pixels[offset + 1] = 255;
                pixels[offset + 2] = 255;
                pixels[offset + 3] = 255;
            }
        }

        using var bitmap = new SKBitmap(
            new SKImageInfo(Size, Size, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        System.Runtime.InteropServices.Marshal.Copy(
            pixels,
            0,
            bitmap.GetPixels(),
            pixels.Length);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private sealed class ThrowingCheck : IPreflightCheck
    {
        public string Code => "throwing";

        public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
            => throw new InvalidOperationException("boom");
    }

    private sealed class PassingCheck : IPreflightCheck
    {
        public string Code => "passing";

        public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
            => PreflightCheckResult.Finding(
                new PreflightFinding("passing", PreflightSeverity.Info, "ok", "ok", null, []));
    }
}
