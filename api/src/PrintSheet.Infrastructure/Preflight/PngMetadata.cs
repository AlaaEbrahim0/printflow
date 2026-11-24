using System.Text;
using PrintSheet.Application.Preflight;

namespace PrintSheet.Infrastructure.Preflight;

/// <summary>
/// The handful of PNG facts the checks need and SkiaSharp does not expose:
/// bit depth, colour type, sRGB presence and physical resolution. Parsing the
/// chunk stream is cheaper than a second decode and is the only way to see
/// metadata Skia drops on the floor.
/// </summary>
internal static class PngMetadata
{
    private static readonly byte[] Signature = [137, 80, 78, 71, 13, 10, 26, 10];
    private static readonly uint[] CrcTable = BuildCrcTable();

    public static PreflightPngInfo Read(byte[] png)
    {
        if (png.Length < 8 || !png.AsSpan(0, 8).SequenceEqual(Signature))
        {
            throw PreflightException.Unsupported("The upload is not a PNG file.");
        }

        var bitDepth = 8;
        var colorType = 6;
        var hasSrgb = false;
        var hasIcc = false;
        var hasTransparencyChunk = false;
        int? dpiX = null;
        int? dpiY = null;

        var offset = 8;
        while (offset + 12 <= png.Length)
        {
            var length = ReadInt32(png, offset);
            if (length < 0 || offset + 12 + length > png.Length)
            {
                throw PreflightException.Unsupported("The PNG chunk stream is truncated.");
            }

            var type = Encoding.ASCII.GetString(png, offset + 4, 4);
            var data = offset + 8;
            switch (type)
            {
                case "IHDR" when length >= 13:
                    bitDepth = png[data + 8];
                    colorType = png[data + 9];
                    break;
                case "sRGB":
                    hasSrgb = true;
                    break;
                case "iCCP":
                    hasIcc = true;
                    break;
                case "tRNS":
                    hasTransparencyChunk = true;
                    break;
                case "pHYs" when length >= 9 && png[data + 8] == 1:
                    dpiX = PixelsPerMetreToDpi(ReadInt32(png, data));
                    dpiY = PixelsPerMetreToDpi(ReadInt32(png, data + 4));
                    break;
            }

            offset += 12 + length;
            if (type == "IEND")
            {
                break;
            }
        }

        var hasAlpha = colorType is 4 or 6 || (colorType == 3 && hasTransparencyChunk);
        return new PreflightPngInfo(bitDepth, colorType, hasAlpha, hasSrgb || hasIcc, dpiX, dpiY);
    }

    /// <summary>
    /// Rewrites the chunk stream, replacing any chunk whose type is supplied and
    /// inserting the new chunks directly after IHDR (the position the PNG spec
    /// requires for sRGB and pHYs).
    /// </summary>
    public static byte[] WithChunks(byte[] png, IReadOnlyList<(string Type, byte[] Data)> chunks)
    {
        if (chunks.Count == 0)
        {
            return png;
        }

        var replaced = chunks.Select(chunk => chunk.Type).ToHashSet(StringComparer.Ordinal);
        var output = new MemoryStream(png.Length + 128);
        output.Write(Signature);

        var offset = 8;
        var inserted = false;
        while (offset + 12 <= png.Length)
        {
            var length = ReadInt32(png, offset);
            var type = Encoding.ASCII.GetString(png, offset + 4, 4);
            var total = 12 + length;

            if (!replaced.Contains(type))
            {
                output.Write(png, offset, total);
            }

            if (!inserted && type == "IHDR")
            {
                foreach (var (chunkType, data) in chunks)
                {
                    WriteChunk(output, chunkType, data);
                }

                inserted = true;
            }

            offset += total;
            if (type == "IEND")
            {
                break;
            }
        }

        return output.ToArray();
    }

    public static byte[] SrgbChunk() => [0];

    public static byte[] PhysChunk(int dpiX, int dpiY)
    {
        var data = new byte[9];
        WriteInt32(data, 0, DpiToPixelsPerMetre(dpiX));
        WriteInt32(data, 4, DpiToPixelsPerMetre(dpiY));
        data[8] = 1;
        return data;
    }

    private static void WriteChunk(Stream stream, string type, byte[] data)
    {
        var header = new byte[8];
        WriteInt32(header, 0, data.Length);
        Encoding.ASCII.GetBytes(type, 0, 4, header, 4);
        stream.Write(header);
        stream.Write(data);

        var crc = Crc(header.AsSpan(4, 4), data);
        var trailer = new byte[4];
        WriteInt32(trailer, 0, unchecked((int)crc));
        stream.Write(trailer);
    }

    private static uint Crc(ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in type)
        {
            crc = CrcTable[(crc ^ value) & 0xFF] ^ (crc >> 8);
        }

        foreach (var value in data)
        {
            crc = CrcTable[(crc ^ value) & 0xFF] ^ (crc >> 8);
        }

        return crc ^ 0xFFFFFFFFu;
    }

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (var index = 0; index < table.Length; index++)
        {
            var value = (uint)index;
            for (var bit = 0; bit < 8; bit++)
            {
                value = (value & 1) != 0 ? 0xEDB88320u ^ (value >> 1) : value >> 1;
            }

            table[index] = value;
        }

        return table;
    }

    private static int ReadInt32(byte[] buffer, int offset)
        => (buffer[offset] << 24)
            | (buffer[offset + 1] << 16)
            | (buffer[offset + 2] << 8)
            | buffer[offset + 3];

    private static void WriteInt32(byte[] buffer, int offset, int value)
    {
        buffer[offset] = (byte)(value >> 24);
        buffer[offset + 1] = (byte)(value >> 16);
        buffer[offset + 2] = (byte)(value >> 8);
        buffer[offset + 3] = (byte)value;
    }

    private static int PixelsPerMetreToDpi(int pixelsPerMetre)
        => (int)Math.Round(pixelsPerMetre * 0.0254, MidpointRounding.AwayFromZero);

    private static int DpiToPixelsPerMetre(int dpi)
        => (int)Math.Round(dpi / 0.0254, MidpointRounding.AwayFromZero);
}

internal sealed record PreflightPngInfo(
    int BitDepth,
    int ColorType,
    bool HasAlphaChannel,
    bool HasSrgbProfile,
    int? DpiX,
    int? DpiY);
