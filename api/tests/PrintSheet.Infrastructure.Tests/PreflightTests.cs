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

    [Fact]
    public void TheDistanceMapMatchesAnExactEuclideanTransform()
    {
        // The distance map drives stroke width, gap width, soft edge and soft
        // interior, so a wrong map is four wrong findings at once. It used an
        // infinite sentinel for "no transparent pixel here", which made the
        // parabola arithmetic evaluate Inf - Inf = NaN and walked the lower
        // envelope off the start of its site list: on random masks 178 of 200
        // images threw, and on a real cut-out 31.3% of pixels were wrong (all
        // overestimates). This compares against a brute-force EDT, which is the
        // only definition of "exact" that does not share the same bug.
        var random = new Random(20261124);
        for (var trial = 0; trial < 60; trial++)
        {
            var width = random.Next(5, 18);
            var height = random.Next(5, 18);
            var pixels = new byte[width * height * 4];
            var alpha = new byte[width * height];
            var density = 0.1 + (random.NextDouble() * 0.6);
            for (var index = 0; index < alpha.Length; index++)
            {
                alpha[index] = (byte)(random.NextDouble() < density ? 0 : 255);
                pixels[(index * 4) + 3] = alpha[index];
            }

            var analysis = PreflightAnalysis.Build(
                new PreflightImage(pixels, width, height, true, 8, true, 300, 300),
                CancellationToken.None);

            for (var y = 0; y < height; y++)
            {
                for (var x = 0; x < width; x++)
                {
                    var nearest = double.MaxValue;
                    for (var otherY = 0; otherY < height; otherY++)
                    {
                        for (var otherX = 0; otherX < width; otherX++)
                        {
                            if (alpha[(otherY * width) + otherX] >= 128)
                            {
                                continue;
                            }

                            var dx = x - otherX;
                            var dy = y - otherY;
                            nearest = Math.Min(nearest, Math.Sqrt((dx * dx) + (dy * dy)));
                        }
                    }

                    // The map is a byte, so the reference is compared at that precision.
                    var expected = (byte)Math.Min(255, (int)nearest);
                    Assert.Equal(expected, analysis.DistanceToTransparent[(y * width) + x]);
                }
            }
        }
    }

    [Fact]
    public void AnAntiAliasedRimIsNotAMatteDefect()
    {
        // A 1 px anti-aliased rim on an opaque shape is what a correct cut-out
        // looks like, so neither the soft-edge nor the soft-interior rule may
        // fire on it. The old share-of-band rule failed exactly this: it required
        // a ramp thinner than one pixel.
        var pixels = new byte[Size * Size * 4];
        for (var y = 100; y < 200; y++)
        {
            for (var x = 100; x < 200; x++)
            {
                var offset = (((y * Size) + x) * 4);
                var rim = x is 100 or 199 || y is 100 or 199;
                pixels[offset] = 255;
                pixels[offset + 1] = 255;
                pixels[offset + 2] = 255;
                pixels[offset + 3] = rim ? (byte)128 : (byte)255;
            }
        }

        var png = new SkiaPreflightImageCodec().Encode(
            new PreflightImage(pixels, Size, Size, true, 8, true, 300, 300));
        var outcome = Run(png, Spec());

        Assert.DoesNotContain(outcome.Report.Findings, f => f.Code == "soft-edge");
        Assert.DoesNotContain(outcome.Report.Findings, f => f.Code == "soft-interior");
    }

    [Fact]
    public void AFeatheredRimIsReportedAsASoftEdge()
    {
        // The same shape with a ramp ten pixels deep: what a blurred or
        // over-feathered matte looks like, and what the rule exists to catch.
        var pixels = new byte[Size * Size * 4];
        for (var y = 100; y < 200; y++)
        {
            for (var x = 100; x < 200; x++)
            {
                var offset = (((y * Size) + x) * 4);
                var depth = Math.Min(
                    Math.Min(x - 100, 199 - x),
                    Math.Min(y - 100, 199 - y));
                var alpha = depth < 10 ? (byte)(25 * (depth + 1)) : (byte)255;
                pixels[offset] = 255;
                pixels[offset + 1] = 255;
                pixels[offset + 2] = 255;
                pixels[offset + 3] = alpha;
            }
        }

        var png = new SkiaPreflightImageCodec().Encode(
            new PreflightImage(pixels, Size, Size, true, 8, true, 300, 300));
        var finding = Assert.Single(Run(png, Spec()).Report.Findings, f => f.Code == "soft-edge");

        Assert.Equal(PreflightSeverity.Warning, finding.Severity);
        Assert.Contains("feathered", finding.Message, StringComparison.Ordinal);
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
