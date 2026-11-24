using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

public sealed class SolidBackgroundRemoverTests
{
    [Fact]
    public async Task LightShapeOnBlackGetsTransparentBackgroundAndOpaqueInterior()
    {
        var png = CreatePng(64, 64, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White, IsAntialias = true };
            canvas.DrawCircle(32, 32, 18, paint);
        });

        var result = await Remover().RemoveAsync(Input(png), CancellationToken.None);

        Assert.Equal(new RgbColor(0, 0, 0), result.BackgroundColor);
        Assert.Equal(0, AlphaAt(result.PngBytes, 2, 2));
        Assert.Equal(255, AlphaAt(result.PngBytes, 32, 32));

        var previous = 0;
        for (var x = 10; x <= 18; x++)
        {
            var alpha = AlphaAt(result.PngBytes, x, 32);
            Assert.InRange(alpha, 0, 255);
            Assert.True(alpha >= previous, $"alpha fell at x={x}: {previous} -> {alpha}");
            previous = alpha;
        }
    }

    [Fact]
    public async Task EnclosedSameColouredHoleStaysOpaque()
    {
        var png = CreatePng(64, 64, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White };
            canvas.DrawRect(SKRect.Create(10, 10, 44, 44), paint);
            using var hole = new SKPaint { Color = SKColors.Black };
            canvas.DrawRect(SKRect.Create(28, 28, 8, 8), hole);
        });

        var result = await Remover().RemoveAsync(Input(png), CancellationToken.None);

        // The inner black square is the same colour as the background but is not
        // border-connected, so flood fill must not reach it.
        Assert.Equal(255, AlphaAt(result.PngBytes, 32, 32));
    }

    [Fact]
    public async Task JpegRecompressionLeavesNoBackgroundSpeckle()
    {
        var png = CreatePng(96, 96, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White, IsAntialias = true };
            canvas.DrawCircle(48, 48, 26, paint);
        });
        var jpeg = Reencode(png, SKEncodedImageFormat.Jpeg, 60);

        var result = await Remover().RemoveAsync(Input(jpeg), CancellationToken.None);

        Assert.Equal(255, AlphaAt(result.PngBytes, 48, 48));
        for (var y = 0; y < 8; y++)
        {
            for (var x = 0; x < 8; x++)
            {
                Assert.Equal(0, AlphaAt(result.PngBytes, x, y));
            }
        }
    }

    [Fact]
    public async Task DarkOnWhiteAndNavyBackgroundsAreNotHardcodedToBlack()
    {
        var onWhite = CreatePng(64, 64, canvas =>
        {
            canvas.Clear(SKColors.White);
            using var paint = new SKPaint { Color = new SKColor(32, 32, 32) };
            canvas.DrawRect(SKRect.Create(20, 20, 24, 24), paint);
        });
        var navy = new SKColor(16, 26, 60);
        var onNavy = CreatePng(64, 64, canvas =>
        {
            canvas.Clear(navy);
            using var paint = new SKPaint { Color = SKColors.White };
            canvas.DrawRect(SKRect.Create(20, 20, 24, 24), paint);
        });

        var whiteResult = await Remover().RemoveAsync(Input(onWhite), CancellationToken.None);
        var navyResult = await Remover().RemoveAsync(Input(onNavy), CancellationToken.None);

        Assert.Equal(new RgbColor(255, 255, 255), whiteResult.BackgroundColor);
        Assert.Equal(0, AlphaAt(whiteResult.PngBytes, 2, 2));
        Assert.Equal(255, AlphaAt(whiteResult.PngBytes, 32, 32));

        Assert.Equal(new RgbColor(navy.Red, navy.Green, navy.Blue), navyResult.BackgroundColor);
        Assert.Equal(0, AlphaAt(navyResult.PngBytes, 2, 2));
        Assert.Equal(255, AlphaAt(navyResult.PngBytes, 32, 32));
    }

    [Fact]
    public async Task ArtworkTouchingTheBorderIsNotApplicable()
    {
        var png = CreatePng(64, 64, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White };
            canvas.DrawRect(SKRect.Create(0, 20, 64, 24), paint);
        });

        var applicability = await Remover().CheckApplicabilityAsync(
            Input(png),
            CancellationToken.None);

        Assert.False(applicability.IsApplicable);
        Assert.Contains(applicability.Reasons, reason => reason.Contains("border", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task APhotoLikeGradientIsNotApplicable()
    {
        var png = CreatePng(64, 64, canvas =>
        {
            using var paint = new SKPaint();
            for (var x = 0; x < 64; x++)
            {
                paint.Color = new SKColor((byte)(x * 4), (byte)(x * 4), (byte)(x * 4));
                canvas.DrawRect(SKRect.Create(x, 0, 1, 64), paint);
            }
        });

        var applicability = await Remover().CheckApplicabilityAsync(
            Input(png),
            CancellationToken.None);

        Assert.False(applicability.IsApplicable);
        Assert.NotEmpty(applicability.Reasons);
    }

    [Fact]
    public async Task SpeckRemovalDropsIsolatedBlobsButKeepsSmallLegitimateParts()
    {
        var png = CreatePng(64, 64, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White };
            canvas.DrawRect(SKRect.Create(8, 8, 20, 20), paint);
            // 2x2 = 4 px core: below the default 12 px floor.
            canvas.DrawRect(SKRect.Create(50, 50, 2, 2), paint);
            // 4x4 = 16 px core: above the floor and legitimate.
            canvas.DrawRect(SKRect.Create(30, 50, 4, 4), paint);
        });

        var result = await Remover().RemoveAsync(Input(png), CancellationToken.None);

        Assert.Equal(0, AlphaAt(result.PngBytes, 50, 50));
        Assert.Equal(255, AlphaAt(result.PngBytes, 18, 18));
        Assert.Equal(255, AlphaAt(result.PngBytes, 31, 51));
    }

    [Fact]
    public async Task IdenticalInputProducesIdenticalBytes()
    {
        var png = CreatePng(128, 96, canvas =>
        {
            canvas.Clear(new SKColor(16, 26, 60));
            using var paint = new SKPaint { Color = SKColors.White, IsAntialias = true };
            canvas.DrawCircle(64, 48, 30, paint);
        });

        var first = await Remover().RemoveAsync(Input(png), CancellationToken.None);
        var second = await Remover().RemoveAsync(Input(png), CancellationToken.None);

        Assert.Equal(SHA256.HashData(first.PngBytes), SHA256.HashData(second.PngBytes));
    }

    [Fact]
    public async Task CancellationIsObserved()
    {
        var png = CreatePng(64, 64, canvas => canvas.Clear(SKColors.Black));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Remover().RemoveAsync(Input(png), new CancellationToken(canceled: true)));
    }

    [Fact]
    public async Task ProcessesAFourThousandPixelSquareInCoarseTime()
    {
        var png = CreatePng(4000, 4000, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White };
            canvas.DrawRect(SKRect.Create(500, 500, 3000, 3000), paint);
        });

        var stopwatch = Stopwatch.StartNew();
        var result = await Remover().RemoveAsync(Input(png), CancellationToken.None);
        stopwatch.Stop();

        Assert.Equal(255, AlphaAt(result.PngBytes, 2000, 2000));
        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(20),
            $"4000x4000 took {stopwatch.Elapsed}.");
    }

    [Fact]
    public async Task DecontaminationRemovesADarkHaloFromSemiTransparentEdges()
    {
        // A 50% white-over-black edge pixel arrives as (127,127,127,128).
        var png = CreateRgbaPng(2, 1, [127, 127, 127, 128, 200, 100, 50, 255]);
        var decontaminated = await new SkiaBackgroundDecontaminator().DecontaminateAsync(
            png,
            new RgbColor(0, 0, 0),
            CancellationToken.None);
        var pixels = DecodeRgba(decontaminated);

        // Unmixed white, so compositing on white leaves a white edge, not a grey one.
        Assert.InRange(pixels[0], 250, 255);
        Assert.InRange(pixels[1], 250, 255);
        Assert.InRange(pixels[2], 250, 255);
        // Opaque pixels are untouched.
        Assert.Equal([200, 100, 50, 255], pixels[4..]);
    }

    private static SolidBackgroundRemover Remover()
        => new(
            Options.Create(new SolidBackgroundRemovalOptions()),
            NullLogger<SolidBackgroundRemover>.Instance);

    private static ImageInput Input(byte[] png) => new(png, "image/png", "art.png");

    private static byte[] CreatePng(int width, int height, Action<SKCanvas> draw)
        => Encode(width, height, draw, SKEncodedImageFormat.Png, 100);

    private static byte[] Reencode(byte[] png, SKEncodedImageFormat format, int quality)
    {
        using var bitmap = SKBitmap.Decode(png);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(format, quality);
        return data.ToArray();
    }

    private static byte[] CreateRgbaPng(int width, int height, byte[] pixels)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        Marshal.Copy(pixels, 0, bitmap.GetPixels(), pixels.Length);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static byte[] Encode(
        int width,
        int height,
        Action<SKCanvas> draw,
        SKEncodedImageFormat format,
        int quality)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        using (var canvas = new SKCanvas(bitmap))
        {
            draw(canvas);
        }

        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(format, quality);
        return data.ToArray();
    }

    private static byte AlphaAt(byte[] png, int x, int y)
    {
        using var bitmap = SKBitmap.Decode(png);
        using var rgba = bitmap.ColorType == SKColorType.Rgba8888
            ? null
            : bitmap.Copy(SKColorType.Rgba8888);
        var source = rgba ?? bitmap;
        var pixels = new byte[source.Width * source.Height * 4];
        Marshal.Copy(source.GetPixels(), pixels, 0, pixels.Length);
        return pixels[(((y * source.Width) + x) * 4) + 3];
    }

    private static byte[] DecodeRgba(byte[] png)
    {
        using var bitmap = SKBitmap.Decode(png);
        using var rgba = bitmap.ColorType == SKColorType.Rgba8888
            ? null
            : bitmap.Copy(SKColorType.Rgba8888);
        var source = rgba ?? bitmap;
        var pixels = new byte[source.Width * source.Height * 4];
        Marshal.Copy(source.GetPixels(), pixels, 0, pixels.Length);
        if (source.AlphaType == SKAlphaType.Premul)
        {
            for (var offset = 0; offset < pixels.Length; offset += 4)
            {
                var alpha = pixels[offset + 3];
                if (alpha is 0 or 255)
                {
                    continue;
                }

                pixels[offset] = (byte)Math.Min(255, pixels[offset] * 255 / alpha);
                pixels[offset + 1] = (byte)Math.Min(255, pixels[offset + 1] * 255 / alpha);
                pixels[offset + 2] = (byte)Math.Min(255, pixels[offset + 2] * 255 / alpha);
            }
        }

        return pixels;
    }
}
