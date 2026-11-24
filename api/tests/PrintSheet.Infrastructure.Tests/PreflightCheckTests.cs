using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Preflight;
using PrintSheet.Infrastructure.Preflight;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// One test per rule, on artwork built to trip exactly that rule. The report is
/// the only thing an operator acts on, so a check that silently stops firing is
/// worse than one that fires wrongly: these pin both the finding and its severity.
/// </summary>
public sealed class PreflightCheckTests
{
    /// <summary>2.54 cm at 300 DPI is exactly the 300 px canvas used here.</summary>
    private static readonly PrintSpec Square = PrintSpec.Create(2.54m, 2.54m, 300, GarmentColor.Dark).Value!;

    [Fact]
    public void AResolutionBelowTheMinimumIsAnError()
    {
        // The same pixels printed 5.08 cm wide are 150 DPI, under the 200 DPI floor.
        var spec = PrintSpec.Create(5.08m, 5.08m, 300, GarmentColor.Dark).Value!;

        var finding = Assert.Single(Run(Canvas.Cutout(300).Encode(), spec).Report.Findings, f => f.Code == "resolution");

        Assert.Equal(PreflightSeverity.Error, finding.Severity);
        Assert.Contains("150 DPI", finding.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnImageWithoutTransparencyFailsTheAlphaCheck()
    {
        var finding = Assert.Single(Run(Canvas.Opaque(300).Encode(), Square).Report.Findings, f => f.Code == "alpha");

        Assert.Equal(PreflightSeverity.Error, finding.Severity);
    }

    [Fact]
    public void InkThatCoversMostOfThePrintAreaWarns()
    {
        // Opaque everywhere but one transparent corner: the alpha check passes,
        // the ink is still ~100% of the print area.
        var canvas = Canvas.Opaque(300);
        canvas.Fill(0, 0, 2, 2, alpha: 0);

        var finding = Assert.Single(Run(canvas.Encode(), Square).Report.Findings, f => f.Code == "coverage");

        Assert.Equal(PreflightSeverity.Warning, finding.Severity);
    }

    [Fact]
    public void InkTouchingTheTrimEdgeWarns()
    {
        var canvas = Canvas.Cutout(300);
        canvas.Fill(0, 100, 100, 100);

        var finding = Assert.Single(Run(canvas.Encode(), Square).Report.Findings, f => f.Code == "safe-margin");

        Assert.Equal(PreflightSeverity.Warning, finding.Severity);
        Assert.Equal(0, finding.Region!.X);
    }

    [Fact]
    public void IslandsBelowTheMinimumAreaWarnAndTheFixRemovesThem()
    {
        var canvas = Canvas.Cutout(300);
        canvas.Fill(100, 100, 100, 100);
        canvas.Fill(30, 30, 3, 3);
        var png = canvas.Encode();

        var before = Run(png, Square);
        Assert.Contains(before.Report.Findings, f => f.Code == "island-area");

        var after = Run(png, Square, applyFixes: true);
        Assert.Contains(after.Report.Fixes, fix => fix.Code == PreflightFixCodes.RemoveIslands);
        Assert.DoesNotContain(after.Report.Findings, f => f.Code == "island-area");
    }

    [Fact]
    public void EnclosedHolesBelowTheMinimumAreaWarnAndTheFixFillsThem()
    {
        var canvas = Canvas.Cutout(300);
        canvas.Fill(100, 100, 100, 100);
        canvas.Fill(140, 140, 4, 4, alpha: 0);
        var png = canvas.Encode();

        var before = Run(png, Square);
        Assert.Contains(before.Report.Findings, f => f.Code == "hole-area");

        var after = Run(png, Square, applyFixes: true);
        Assert.Contains(after.Report.Fixes, fix => fix.Code == PreflightFixCodes.FillHoles);
        Assert.DoesNotContain(after.Report.Findings, f => f.Code == "hole-area");
    }

    [Fact]
    public void AStrokeThinnerThanTheCriticalWidthIsAnError()
    {
        // 1 px at 300 DPI is 0.169 mm of stroke, under the 0.25 mm floor. The
        // line is long enough to clear the island-area floor, which is a separate
        // rule and would otherwise hide it.
        var canvas = Canvas.Cutout(300);
        canvas.Fill(100, 50, 1, 200);

        var finding = Assert.Single(Run(canvas.Encode(), Square).Report.Findings, f => f.Code == "stroke-width");

        Assert.Equal(PreflightSeverity.Error, finding.Severity);
    }

    [Fact]
    public void TwoShapesCloserThanTheMinimumGapWarn()
    {
        var canvas = Canvas.Cutout(300);
        canvas.Fill(80, 100, 60, 100);
        canvas.Fill(142, 100, 60, 100);

        var finding = Assert.Single(Run(canvas.Encode(), Square).Report.Findings, f => f.Code == "gap-width");

        Assert.Equal(PreflightSeverity.Warning, finding.Severity);
    }

    [Fact]
    public void MoreRegionsThanTheLimitWarn()
    {
        var canvas = Canvas.Cutout(300);
        for (var index = 0; index < 11; index++)
        {
            canvas.Fill(20 + ((index % 4) * 70), 20 + ((index / 4) * 90), 30, 30);
        }

        var finding = Assert.Single(Run(canvas.Encode(), Square).Report.Findings, f => f.Code == "region-count");

        Assert.Equal(PreflightSeverity.Warning, finding.Severity);
    }

    [Fact]
    public void InkThatDisappearsOnTheGarmentWarns()
    {
        // Near-black ink on a black shirt is invisible long before it is unprintable.
        var canvas = Canvas.Cutout(300);
        canvas.Fill(100, 100, 100, 100, r: 10, g: 10, b: 10);

        var findings = Run(canvas.Encode(), Square).Report.Findings
            .Where(f => f.Code == "contrast")
            .ToArray();

        Assert.NotEmpty(findings);
        Assert.All(findings, finding => Assert.Equal(PreflightSeverity.Warning, finding.Severity));
    }

    [Fact]
    public void AMissingColourProfileWarnsAndTheFixEmbedsOne()
    {
        var png = Canvas.Cutout(300).EncodePlain();

        Assert.Contains(Run(png, Square).Report.Findings, f => f.Code == "icc-profile");

        var after = Run(png, Square, applyFixes: true);
        Assert.Contains(after.Report.Fixes, fix => fix.Code == PreflightFixCodes.EmbedSrgb);
        Assert.DoesNotContain(after.Report.Findings, f => f.Code == "icc-profile");
    }

    [Fact]
    public void ReportOnlyIsTheDefaultAndReturnsNoPng()
    {
        var outcome = Run(Canvas.Cutout(300).Encode(), Square);

        Assert.Null(outcome.FixedPng);
        Assert.Empty(outcome.Report.Fixes);
    }

    [Fact]
    public void AnUnknownProfileIsRejectedWithTheConfiguredName()
    {
        var outcome = Service().Run(
            Canvas.Cutout(300).Encode(),
            Square,
            Square.Dpi,
            Square.Garment,
            profileName: "screen-print",
            applyFixes: false,
            CancellationToken.None);

        Assert.False(outcome.IsSuccess);
        Assert.Contains("dtf", outcome.Error!.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ASpecIsDerivedFromThePixelsWhenTheCallerHasNoPrintSize()
    {
        var outcome = Service().Run(
            Canvas.Cutout(300).Encode(),
            spec: null,
            dpi: 300,
            GarmentColor.Light,
            profileName: null,
            applyFixes: false,
            CancellationToken.None);

        Assert.True(outcome.IsSuccess, outcome.Error?.Message);
        Assert.Equal(2.54m, outcome.Value!.Report.Spec.WidthCm);
        Assert.Equal("light", outcome.Value.Report.Spec.GarmentColor);
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

    /// <summary>An RGBA canvas painted rectangle by rectangle.</summary>
    private sealed class Canvas
    {
        private readonly int _size;
        private readonly byte[] _pixels;

        private Canvas(int size)
        {
            _size = size;
            _pixels = new byte[size * size * 4];
        }

        /// <summary>Everything transparent: the background is already gone.</summary>
        public static Canvas Cutout(int size) => new(size);

        /// <summary>Everything opaque white: a flattened rectangle of background.</summary>
        public static Canvas Opaque(int size)
        {
            var canvas = new Canvas(size);
            canvas.Fill(0, 0, size, size);
            return canvas;
        }

        public Canvas Fill(
            int x,
            int y,
            int width,
            int height,
            byte alpha = 255,
            byte r = 255,
            byte g = 255,
            byte b = 255)
        {
            for (var row = y; row < y + height; row++)
            {
                for (var column = x; column < x + width; column++)
                {
                    var offset = (((row * _size) + column) * 4);
                    _pixels[offset] = r;
                    _pixels[offset + 1] = g;
                    _pixels[offset + 2] = b;
                    _pixels[offset + 3] = alpha;
                }
            }

            return this;
        }

        /// <summary>Encoded with sRGB and pHYs, so the metadata rules stay quiet.</summary>
        public byte[] Encode()
            => new SkiaPreflightImageCodec().Encode(
                new PreflightImage(_pixels, _size, _size, true, 8, true, 300, 300));

        /// <summary>Encoded the way a screenshot arrives: no sRGB, no pHYs.</summary>
        public byte[] EncodePlain()
        {
            using var bitmap = new SKBitmap(
                new SKImageInfo(_size, _size, SKColorType.Rgba8888, SKAlphaType.Unpremul));
            System.Runtime.InteropServices.Marshal.Copy(_pixels, 0, bitmap.GetPixels(), _pixels.Length);
            using var image = SKImage.FromBitmap(bitmap);
            using var data = image.Encode(SKEncodedImageFormat.Png, 100);
            return data.ToArray();
        }
    }
}
