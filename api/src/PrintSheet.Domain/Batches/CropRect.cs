using System.Text.Json.Serialization;
using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// Pixel rectangle with a top-left origin, used for manual crops and trim
/// results. Bounds are validated against the parent image by the application
/// layer; this value object only enforces its own invariants.
/// </summary>
public sealed record CropRect
{
    private CropRect(int x, int y, int width, int height)
    {
        X = x;
        Y = y;
        Width = width;
        Height = height;
    }

    public int X { get; }

    public int Y { get; }

    public int Width { get; }

    public int Height { get; }

    [JsonIgnore]
    public long Area => (long)Width * Height;

    public static Result<CropRect> Create(int x, int y, int width, int height)
    {
        if (x < 0 || y < 0)
        {
            return Result<CropRect>.Failure(
                ErrorCodes.InvalidRequest,
                "Crop origin must not be negative.");
        }

        if (width < 1 || height < 1)
        {
            return Result<CropRect>.Failure(
                ErrorCodes.InvalidRequest,
                "Crop width and height must be at least one pixel.");
        }

        return Result<CropRect>.Success(new CropRect(x, y, width, height));
    }

    public Result ValidateWithin(int parentWidthPx, int parentHeightPx)
    {
        if (parentWidthPx < 1 || parentHeightPx < 1)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Parent dimensions must be positive.");
        }

        if ((long)X + Width > parentWidthPx || (long)Y + Height > parentHeightPx)
        {
            return Result.Failure(
                ErrorCodes.InvalidRequest,
                $"Crop rectangle {X},{Y} {Width}x{Height} exceeds the parent image "
                + $"{parentWidthPx}x{parentHeightPx}.");
        }

        return Result.Success();
    }
}
