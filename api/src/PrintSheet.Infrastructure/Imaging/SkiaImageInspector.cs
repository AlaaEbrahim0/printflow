using System.Buffers.Binary;
using PrintSheet.Application.Abstractions;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Imaging;

/// <summary>Reads image metadata without decoding the full raster.</summary>
public sealed class SkiaImageInspector : IImageInspector
{
    private const int TiffMagic = 42;
    private const int BigTiffMagic = 43;

    public async Task<ImageInspection> InspectAsync(Stream stream, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (stream.CanSeek)
        {
            stream.Position = 0;
        }

        var prefix = new byte[4];
        var bytesRead = await stream.ReadAsync(prefix, cancellationToken);
        if (stream.CanSeek)
        {
            stream.Position = 0;
        }

        if (bytesRead == prefix.Length && IsTiff(prefix))
        {
            if (!stream.CanSeek)
            {
                throw new InvalidOperationException("TIFF inspection requires a seekable stream.");
            }

            return InspectTiff(stream);
        }

        using var codec = stream.CanSeek
            ? SKCodec.Create(new NonDisposingStream(stream))
            : SKCodec.Create(new PrefixStream(prefix.AsMemory(0, bytesRead), stream));
        if (codec is null)
        {
            throw new InvalidOperationException("The image format could not be detected.");
        }

        var format = codec.EncodedFormat.ToString().ToLowerInvariant();
        var (extension, contentType) = format switch
        {
            "png" => (".png", "image/png"),
            "jpeg" => (".jpg", "image/jpeg"),
            "webp" => (".webp", "image/webp"),
            "gif" => (".gif", "image/gif"),
            "bmp" => (".bmp", "image/bmp"),
            "ico" => (".ico", "image/x-icon"),
            "wbmp" => (".wbmp", "image/vnd.wap.wbmp"),
            "avif" => (".avif", "image/avif"),
            "heif" => (".heif", "image/heif"),
            _ => throw new InvalidOperationException($"Unsupported image format: {format}."),
        };
        var info = codec.Info;

        return new ImageInspection(
            info.Width,
            info.Height,
            info.AlphaType is SKAlphaType.Premul or SKAlphaType.Unpremul,
            format,
            contentType,
            extension);
    }

    private static bool IsTiff(ReadOnlySpan<byte> prefix)
        => (prefix[0] == (byte)'I' && prefix[1] == (byte)'I'
                && prefix[2] == TiffMagic && prefix[3] == 0)
            || (prefix[0] == (byte)'M' && prefix[1] == (byte)'M'
                && prefix[2] == 0 && prefix[3] == TiffMagic);

    private static ImageInspection InspectTiff(Stream stream)
    {
        var header = new byte[16];
        stream.Position = 0;
        stream.ReadExactly(header.AsSpan(0, 8));

        var littleEndian = header[0] == (byte)'I';
        var magic = ReadUInt16(header.AsSpan(2), littleEndian);
        var isBigTiff = magic == BigTiffMagic;
        if (magic != TiffMagic && !isBigTiff)
        {
            throw new InvalidOperationException("The TIFF header is invalid.");
        }

        var offsetSize = 4;
        long directoryOffset;
        if (isBigTiff)
        {
            stream.ReadExactly(header.AsSpan(8, 8));
            if (ReadUInt16(header.AsSpan(4), littleEndian) != 8
                || ReadUInt16(header.AsSpan(6), littleEndian) != 0)
            {
                throw new InvalidOperationException("The BigTIFF header is invalid.");
            }

            offsetSize = 8;
            directoryOffset = ToStreamOffset(ReadUInt64(header.AsSpan(8), littleEndian));
        }
        else
        {
            directoryOffset = ReadUInt32(header.AsSpan(4), littleEndian);
        }

        var countSize = isBigTiff ? 8 : 2;
        var entrySize = isBigTiff ? 20 : 12;
        var directoryCountPosition = directoryOffset;
        if (directoryCountPosition < 0 || directoryCountPosition > stream.Length - countSize)
        {
            throw new InvalidOperationException("The TIFF image directory is outside the file.");
        }

        stream.Position = directoryCountPosition;
        stream.ReadExactly(header.AsSpan(0, countSize));
        var entryCount = isBigTiff
            ? ToStreamOffset(ReadUInt64(header, littleEndian))
            : ReadUInt16(header, littleEndian);
        var entriesStart = checked(directoryCountPosition + countSize);
        var availableEntries = (stream.Length - entriesStart) / entrySize;
        if (entryCount < 1 || entryCount > availableEntries)
        {
            throw new InvalidOperationException("The TIFF image directory is incomplete.");
        }

        uint? width = null;
        uint? height = null;
        uint samplesPerPixel = 1;
        uint photometric = 0;
        var hasExtraSamples = false;
        var valueFieldSize = offsetSize;
        var entryBuffer = new byte[entrySize];

        for (long index = 0; index < entryCount; index++)
        {
            stream.Position = checked(entriesStart + index * entrySize);
            stream.ReadExactly(entryBuffer);
            var entry = entryBuffer.AsSpan();
            var tag = ReadUInt16(entry, littleEndian);
            var type = ReadUInt16(entry[2..], littleEndian);
            var count = isBigTiff
                ? ReadUInt64(entry[4..], littleEndian)
                : ReadUInt32(entry[4..], littleEndian);
            var valueField = entry[(isBigTiff ? 12 : 8)..];

            switch (tag)
            {
                case 256:
                    width = ReadTiffScalar(stream, type, count, valueField, valueFieldSize, littleEndian);
                    break;
                case 257:
                    height = ReadTiffScalar(stream, type, count, valueField, valueFieldSize, littleEndian);
                    break;
                case 277:
                    samplesPerPixel = ReadTiffScalar(
                        stream, type, count, valueField, valueFieldSize, littleEndian);
                    break;
                case 262:
                    photometric = ReadTiffScalar(
                        stream, type, count, valueField, valueFieldSize, littleEndian);
                    break;
                case 338:
                    hasExtraSamples = count > 0;
                    break;
            }
        }

        if (width is not > 0 or > int.MaxValue || height is not > 0 or > int.MaxValue)
        {
            throw new InvalidOperationException("The TIFF image dimensions are invalid.");
        }

        return new ImageInspection(
            (int)width.Value,
            (int)height.Value,
            hasExtraSamples || (samplesPerPixel >= 4 && photometric == 2),
            "tiff",
            "image/tiff",
            ".tif");
    }

    private static uint ReadTiffScalar(
        Stream stream,
        ushort type,
        ulong count,
        ReadOnlySpan<byte> valueField,
        int valueFieldSize,
        bool littleEndian)
    {
        if (count < 1)
        {
            throw new InvalidOperationException("The TIFF scalar tag is empty.");
        }

        var typeSize = type switch
        {
            1 or 2 or 6 or 7 => 1,
            3 or 8 => 2,
            4 or 9 or 11 or 13 => 4,
            16 or 17 or 18 => 8,
            _ => throw new InvalidOperationException($"Unsupported TIFF scalar type: {type}."),
        };
        var valueOffset = checked((long)count * typeSize) <= valueFieldSize
            ? -1
            : ToStreamOffset(valueFieldSize == 8
                ? ReadUInt64(valueField, littleEndian)
                : ReadUInt32(valueField, littleEndian));

        Span<byte> value = stackalloc byte[8];
        if (valueOffset < 0)
        {
            valueField[..typeSize].CopyTo(value);
        }
        else
        {
            if (valueOffset > stream.Length - typeSize)
            {
                throw new InvalidOperationException("A TIFF tag value is outside the file.");
            }

            stream.Position = valueOffset;
            stream.ReadExactly(value[..typeSize]);
        }

        return typeSize switch
        {
            1 => value[0],
            2 => ReadUInt16(value, littleEndian),
            4 => ReadUInt32(value, littleEndian),
            8 => ToUInt32(ReadUInt64(value, littleEndian)),
            _ => throw new InvalidOperationException($"Unsupported TIFF scalar type: {type}."),
        };
    }

    private static ushort ReadUInt16(ReadOnlySpan<byte> value, bool littleEndian)
        => littleEndian
            ? BinaryPrimitives.ReadUInt16LittleEndian(value)
            : BinaryPrimitives.ReadUInt16BigEndian(value);

    private static uint ReadUInt32(ReadOnlySpan<byte> value, bool littleEndian)
        => littleEndian
            ? BinaryPrimitives.ReadUInt32LittleEndian(value)
            : BinaryPrimitives.ReadUInt32BigEndian(value);

    private static ulong ReadUInt64(ReadOnlySpan<byte> value, bool littleEndian)
        => littleEndian
            ? BinaryPrimitives.ReadUInt64LittleEndian(value)
            : BinaryPrimitives.ReadUInt64BigEndian(value);

    private static long ToStreamOffset(ulong value)
        => value <= long.MaxValue
            ? (long)value
            : throw new InvalidOperationException("The TIFF offset is too large.");

    private static uint ToUInt32(ulong value)
        => value <= uint.MaxValue
            ? (uint)value
            : throw new InvalidOperationException("The TIFF dimension is too large.");

    private sealed class NonDisposingStream(Stream source) : Stream
    {
        public override bool CanRead => source.CanRead;
        public override bool CanSeek => source.CanSeek;
        public override bool CanWrite => false;
        public override long Length => source.Length;
        public override long Position
        {
            get => source.Position;
            set => source.Position = value;
        }

        public override int Read(byte[] buffer, int offset, int count)
            => source.Read(buffer, offset, count);

        public override int Read(Span<byte> buffer) => source.Read(buffer);

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
            => source.ReadAsync(buffer, cancellationToken);

        public override Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken)
            => source.ReadAsync(buffer, offset, count, cancellationToken);

        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => source.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();
    }

    private sealed class PrefixStream(ReadOnlyMemory<byte> prefix, Stream source) : Stream
    {
        private int _prefixPosition;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var copied = ReadPrefix(buffer.AsSpan(offset, count));
            return copied > 0 ? copied : source.Read(buffer, offset, count);
        }

        public override int Read(Span<byte> buffer)
        {
            var copied = ReadPrefix(buffer);
            return copied > 0 ? copied : source.Read(buffer);
        }

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            var copied = ReadPrefix(buffer.Span);
            return copied > 0
                ? ValueTask.FromResult(copied)
                : source.ReadAsync(buffer, cancellationToken);
        }

        public override Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken)
            => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        private int ReadPrefix(Span<byte> destination)
        {
            var remaining = prefix.Length - _prefixPosition;
            if (remaining <= 0 || destination.IsEmpty)
            {
                return 0;
            }

            var count = Math.Min(remaining, destination.Length);
            prefix.Span.Slice(_prefixPosition, count).CopyTo(destination);
            _prefixPosition += count;
            return count;
        }
    }
}
