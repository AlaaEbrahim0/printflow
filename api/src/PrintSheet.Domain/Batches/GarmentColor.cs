using System.Text.RegularExpressions;
using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// Preview-only background used to judge alpha edges. Never baked into a
/// version or export.
/// </summary>
public sealed partial record GarmentColor
{
    public static readonly GarmentColor Light = new(GarmentColorKind.Light, null);
    public static readonly GarmentColor Dark = new(GarmentColorKind.Dark, null);

    private GarmentColor(GarmentColorKind kind, string? hex)
    {
        Kind = kind;
        Hex = hex;
    }

    /// <summary>For EF Core materialisation only.</summary>
    private GarmentColor()
    {
    }

    public GarmentColorKind Kind { get; }

    public string? Hex { get; }

    public static Result<GarmentColor> Create(GarmentColorKind kind, string? hex)
    {
        if (kind == GarmentColorKind.Custom)
        {
            if (string.IsNullOrWhiteSpace(hex) || !HexPattern().IsMatch(hex))
            {
                return Result<GarmentColor>.Failure(
                    ErrorCodes.InvalidRequest,
                    "A custom garment colour requires a #RRGGBB hex value.");
            }

            return Result<GarmentColor>.Success(new GarmentColor(kind, hex.ToUpperInvariant()));
        }

        return Result<GarmentColor>.Success(new GarmentColor(kind, null));
    }

    [GeneratedRegex("^#[0-9A-Fa-f]{6}$")]
    private static partial Regex HexPattern();
}
