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

    [Fact]
    public async Task ASoftSourceEdgeDoesNotLeaveAnOpaqueNearBackgroundRing()
    {
        // The defect this pins: the edge ramp used to stop at a fixed radius, so
        // on a source whose transition is wider than that radius the first pixel
        // past the band was forced fully opaque while still carrying the
        // background colour. Measured on a 3 px-blurred disc at JPEG q70, that
        // pixel came out at (107,107,107) with alpha 255 immediately next to a
        // ramp pixel of alpha 74 — 25-40% grey that prints as a dirty outline on
        // a garment. A blurred edge is exactly what a low-quality customer upload
        // has, so this is the common case, not an exotic one.
        var png = CreatePng(400, 400, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White, IsAntialias = true };
            paint.ImageFilter = SKImageFilter.CreateBlur(3f, 3f);
            canvas.DrawCircle(200, 200, 120, paint);
        });
        var jpeg = Reencode(png, SKEncodedImageFormat.Jpeg, 70);

        var result = await Remover().RemoveAsync(Input(jpeg), CancellationToken.None);

        var (rgb, alpha, width, height) = DecodeRgbaSplit(result.PngBytes);
        var background = result.BackgroundColor!.Value;

        // Any fully opaque pixel that is still visually dark is ink the operator
        // did not ask for; on a white-on-black design it can only come from the
        // background.
        var darkOpaque = 0;
        var opaque = 0;
        for (var i = 0; i < width * height; i++)
        {
            if (alpha[i] != 255)
            {
                continue;
            }

            opaque++;
            var sum = rgb[i * 3] + rgb[(i * 3) + 1] + rgb[(i * 3) + 2];
            if (sum < 300)
            {
                darkOpaque++;
            }
        }

        Assert.True(opaque > 1000, $"the fixture produced only {opaque} opaque pixels.");
        Assert.True(
            darkOpaque == 0,
            $"{darkOpaque} of {opaque} opaque pixels are visually dark, i.e. a background ring survived.");

        // And the ramp must actually be continuous: no opaque pixel may sit next
        // to a near-transparent one, which is the signature of a truncated band.
        var cliffs = 0;
        for (var i = 0; i < width * height; i++)
        {
            if (alpha[i] != 255)
            {
                continue;
            }

            var x = i % width;
            var y = i / width;
            var lowest = 255;
            if (x > 0) lowest = Math.Min(lowest, alpha[i - 1]);
            if (x < width - 1) lowest = Math.Min(lowest, alpha[i + 1]);
            if (y > 0) lowest = Math.Min(lowest, alpha[i - width]);
            if (y < height - 1) lowest = Math.Min(lowest, alpha[i + width]);
            if (lowest < 128)
            {
                cliffs++;
            }
        }

        Assert.True(cliffs == 0, $"{cliffs} opaque pixels sit directly next to a near-transparent pixel.");

        // The background itself must still be fully cleared.
        Assert.Equal(0, alpha[2]);
        Assert.Equal(0, AlphaAt(result.PngBytes, 2, 2));
        _ = background;
    }

    [Fact]
    public async Task TheRampStillStopsAtItsCeiling()
    {
        // The band grows past its floor only while the ramp is incomplete, and it
        // must still stop: a design whose ink is close to the background colour
        // would otherwise be flooded from the border inwards.
        var png = CreatePng(200, 200, canvas =>
        {
            canvas.Clear(SKColors.Black);
            // Ink only 40/255 from the background colour, so the ramp reference is
            // low and every pixel of the shape is "incomplete" by distance.
            using var paint = new SKPaint { Color = new SKColor(40, 40, 40), IsAntialias = true };
            canvas.DrawRect(SKRect.Create(80, 80, 40, 40), paint);
        });

        var options = new SolidBackgroundRemovalOptions
        {
            MaxEdgeBandPixels = 4,
        };
        var remover = new SolidBackgroundRemover(
            Options.Create(options),
            NullLogger<SolidBackgroundRemover>.Instance);

        var result = await remover.RemoveAsync(Input(png), CancellationToken.None);

        // The centre of a 40x40 block is 20 px from the background: beyond the
        // ceiling, so it must stay fully opaque.
        Assert.Equal(255, AlphaAt(result.PngBytes, 100, 100));
    }

    [Fact]
    public async Task AnUpscaledSoftEdgeRampIsFollowedToItsEnd()
    {
        // The ramp is upscaled with the artwork, so a source transition of a few
        // pixels becomes a wide one at print size. Measured live on a 2.5 px
        // blurred ring upscaled 4x: the transition spans exactly 12 px, and a
        // ceiling of 12 stopped one pixel short, leaving a fully opaque
        // (115,115,115) ring. The band must follow the ramp to its real end
        // rather than stopping at a radius that happens to fit a hard edge.
        var png = CreatePng(300, 300, canvas =>
        {
            canvas.Clear(SKColors.Black);
            using var paint = new SKPaint { Color = SKColors.White, IsAntialias = true };
            // ~12 px transition, the measured width of an upscaled soft source.
            paint.ImageFilter = SKImageFilter.CreateBlur(6f, 6f);
            canvas.DrawCircle(150, 150, 90, paint);
        });

        var result = await Remover().RemoveAsync(Input(png), CancellationToken.None);

        var (rgb, alpha, width, height) = DecodeRgbaSplit(result.PngBytes);
        var cliffs = 0;
        var darkOpaque = 0;
        for (var i = 0; i < width * height; i++)
        {
            if (alpha[i] != 255)
            {
                continue;
            }

            if (rgb[i * 3] + rgb[(i * 3) + 1] + rgb[(i * 3) + 2] < 300)
            {
                darkOpaque++;
            }

            var x = i % width;
            var y = i / width;
            var lowest = 255;
            if (x > 0) lowest = Math.Min(lowest, alpha[i - 1]);
            if (x < width - 1) lowest = Math.Min(lowest, alpha[i + 1]);
            if (y > 0) lowest = Math.Min(lowest, alpha[i - width]);
            if (y < height - 1) lowest = Math.Min(lowest, alpha[i + width]);
            if (lowest < 128)
            {
                cliffs++;
            }
        }

        Assert.True(darkOpaque == 0, $"{darkOpaque} opaque pixels are still background-dark.");
        Assert.True(cliffs == 0, $"{cliffs} opaque pixels sit next to a near-transparent pixel.");
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

    private static (byte[] Rgb, byte[] Alpha, int Width, int Height) DecodeRgbaSplit(byte[] png)
    {
        var pixels = DecodeRgba(png);
        using var bitmap = SKBitmap.Decode(png);
        var width = bitmap.Width;
        var height = bitmap.Height;
        var rgb = new byte[width * height * 3];
        var alpha = new byte[width * height];
        for (var i = 0; i < width * height; i++)
        {
            rgb[i * 3] = pixels[i * 4];
            rgb[(i * 3) + 1] = pixels[(i * 4) + 1];
            rgb[(i * 3) + 2] = pixels[(i * 4) + 2];
            alpha[i] = pixels[(i * 4) + 3];
        }

        return (rgb, alpha, width, height);
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
