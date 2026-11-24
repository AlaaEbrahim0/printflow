using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Domain.Tests;

public sealed class PreflightTests
{
    [Fact]
    public void PixelsForASpecUseTheSharedConversionRule()
    {
        var spec = PrintSpec.Create(58m, 10m, 300, GarmentColor.Light).Value!;

        Assert.Equal(6850, spec.WidthPx);
        Assert.Equal(1181, spec.HeightPx);
    }

    [Fact]
    public void ASpecWithoutAPhysicalSizeIsDerivedFromPixels()
    {
        var spec = PrintSpec.FromPixels(1181, 1181, 300, GarmentColor.Dark);

        Assert.Equal(300, spec.Dpi);
        Assert.Equal(1181, spec.WidthPx);
        Assert.Equal(GarmentColor.Dark, spec.Garment);
    }

    [Fact]
    public void NonPositiveSizesAndOutOfRangeDpiAreRejected()
    {
        Assert.False(PrintSpec.Create(0m, 10m, 300, GarmentColor.Light).IsSuccess);
        Assert.False(PrintSpec.Create(10m, 10m, 10, GarmentColor.Light).IsSuccess);
        Assert.False(PrintSpec.Create(10m, 10m, 5000, GarmentColor.Light).IsSuccess);
    }

    [Fact]
    public void TheDefaultProfileIsValid()
    {
        Assert.Empty(new PreflightProfile().Validate());
    }

    [Fact]
    public void ContradictoryThresholdsAreRejectedWithTheOffendingField()
    {
        var errors = new PreflightProfile
        {
            MinimumDpi = 400,
            RecommendedDpi = 300,
            CriticalStrokeMm = 0.9,
            MinimumStrokeMm = 0.5,
            ContrastOpacities = [0, 1.5],
        }.Validate();

        Assert.Contains(errors, error => error.Contains("RecommendedDpi", StringComparison.Ordinal));
        Assert.Contains(errors, error => error.Contains("CriticalStrokeMm", StringComparison.Ordinal));
        Assert.Contains(errors, error => error.Contains("ContrastOpacities", StringComparison.Ordinal));    }

    [Fact]
    public void AVerdictIsTheWorstFindingSeverity()
    {
        var spec = PrintSpec.Create(10m, 10m, 300, GarmentColor.Dark).Value!;

        Assert.Equal(
            PreflightVerdict.Pass,
            PreflightReport.Build(new PreflightProfile(), spec, [], [], []).Verdict);
        Assert.Equal(
            PreflightVerdict.Warn,
            PreflightReport.Build(new PreflightProfile(), spec, [Finding(PreflightSeverity.Warning)], [], []).Verdict);
        Assert.Equal(
            PreflightVerdict.Fail,
            PreflightReport.Build(
                new PreflightProfile(),
                spec,
                [Finding(PreflightSeverity.Warning), Finding(PreflightSeverity.Error)],
                [],
                []).Verdict);
    }

    [Fact]
    public void TheReportNamesTheGarmentColourInContractCasing()
    {
        var spec = PrintSpec.Create(10m, 10m, 300, GarmentColor.Dark).Value!;
        var report = PreflightReport.Build(new PreflightProfile(), spec, [], [], []);

        Assert.Equal("dark", report.Spec.GarmentColor);
        Assert.Equal(PreflightReport.CurrentSchemaVersion, report.SchemaVersion);
        Assert.Equal(PreflightProfile.DefaultName, report.Profile);
    }

    private static PreflightFinding Finding(PreflightSeverity severity)
        => new("test", severity, "Test", "Test", null, []);
}
