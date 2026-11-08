using System.Buffers.Binary;
using PrintSheet.Infrastructure.Imaging;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

public sealed class SkiaImageInspectorTests
{
    [Theory]
    [InlineData(SKEncodedImageFormat.Png, "png", "image/png", ".png", true)]
    [InlineData(SKEncodedImageFormat.Jpeg, "jpeg", "image/jpeg", ".jpg", false)]
    [InlineData(SKEncodedImageFormat.Webp, "webp", "image/webp", ".webp", true)]
    public async Task InspectsSupportedRasterMetadata(
        SKEncodedImageFormat encodedFormat,
        string format,
        string contentType,
        string extension,
        bool hasAlpha)
    {
        using var bitmap = new SKBitmap(12, 8, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        using var encoded = bitmap.Encode(encodedFormat, 100);
        await using var stream = new MemoryStream(encoded.ToArray());
        var inspector = new SkiaImageInspector();

        var result = await inspector.InspectAsync(stream, CancellationToken.None);

        Assert.Equal(12, result.WidthPx);
        Assert.Equal(8, result.HeightPx);
        Assert.Equal(hasAlpha, result.HasAlpha);
        Assert.Equal(format, result.Format);
        Assert.Equal(contentType, result.ContentType);
        Assert.Equal(extension, result.FileExtension);
        Assert.True(stream.CanRead);
    }

    [Fact]
    public async Task InspectsClassicTiffDimensionsAndAlphaWithoutRasterDecode()
    {
        await using var stream = new MemoryStream(CreateTiff());
        var inspector = new SkiaImageInspector();

        var result = await inspector.InspectAsync(stream, CancellationToken.None);

        Assert.Equal(24, result.WidthPx);
        Assert.Equal(10, result.HeightPx);
        Assert.True(result.HasAlpha);
        Assert.Equal("tiff", result.Format);
        Assert.Equal("image/tiff", result.ContentType);
        Assert.Equal(".tif", result.FileExtension);
    }

    [Fact]
    public async Task RejectsTruncatedTiffDirectory()
    {
        await using var stream = new MemoryStream([0x49, 0x49, 42, 0, 8, 0, 0, 0, 2, 0]);
        var inspector = new SkiaImageInspector();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => inspector.InspectAsync(stream, CancellationToken.None));
    }

    private static byte[] CreateTiff()
    {
        const int entryCount = 4;
        var bytes = new byte[8 + 2 + entryCount * 12 + 4];
        bytes[0] = (byte)'I';
        bytes[1] = (byte)'I';
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(2), 42);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), 8);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(8), entryCount);
        WriteEntry(bytes, 10, 256, 4, 24);
        WriteEntry(bytes, 22, 257, 4, 10);
        WriteEntry(bytes, 34, 262, 3, 2);
        WriteEntry(bytes, 46, 338, 3, 1);
        return bytes;
    }

    private static void WriteEntry(byte[] bytes, int offset, ushort tag, ushort type, uint value)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset), tag);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset + 2), type);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset + 4), 1);
        if (type == 3)
        {
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset + 8), (ushort)value);
        }
        else
        {
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset + 8), value);
        }
    }
}
