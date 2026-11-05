using PrintSheet.Domain.Units;

namespace PrintSheet.Domain.Tests;

public sealed class PrintUnitsTests
{
    [Theory]
    [InlineData(58, 300, 6850)]
    [InlineData(20, 300, 2362)]
    [InlineData(10, 300, 1181)]
    [InlineData(30, 300, 3543)]
    [InlineData(2.54, 300, 300)]
    [InlineData(10, 150, 591)]
    public void PixelsForCentimeters_RoundsHalfAwayFromZero(
        decimal centimeters,
        int dpi,
        int expectedPixels)
    {
        Assert.Equal(expectedPixels, PrintUnits.PixelsForCentimeters(centimeters, dpi));
    }

    [Fact]
    public void EffectiveDpi_ReportsLowResolutionSource()
    {
        var dpi = PrintUnits.EffectiveDpi(316, 10m);

        Assert.Equal(80.264m, decimal.Round(dpi, 3));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void PixelsForCentimeters_RejectsNonPositiveLength(decimal centimeters)
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => PrintUnits.PixelsForCentimeters(centimeters, 300));
    }

    [Fact]
    public void PixelsForCentimeters_RejectsNonPositiveDpi()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => PrintUnits.PixelsForCentimeters(10m, 0));
    }
}
