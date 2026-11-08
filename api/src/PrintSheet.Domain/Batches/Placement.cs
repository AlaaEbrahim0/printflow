using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// Translation plus a multiple-of-90-degree rotation of one approved version
/// on the master sheet. The packer never resamples, recolors or crops.
/// </summary>
public sealed record Placement
{
    private Placement(
        Guid designId,
        Guid versionId,
        string? designName,
        decimal xCm,
        decimal yCm,
        decimal widthCm,
        decimal heightCm,
        int widthPx,
        int heightPx,
        int rotationDeg)
    {
        DesignId = designId;
        VersionId = versionId;
        DesignName = designName;
        XCm = xCm;
        YCm = yCm;
        WidthCm = widthCm;
        HeightCm = heightCm;
        WidthPx = widthPx;
        HeightPx = heightPx;
        RotationDeg = rotationDeg;
    }

    public Guid DesignId { get; }

    public Guid VersionId { get; }

    public string? DesignName { get; }

    public decimal XCm { get; }

    public decimal YCm { get; }

    public decimal WidthCm { get; }

    public decimal HeightCm { get; }

    public int WidthPx { get; }

    public int HeightPx { get; }

    public int RotationDeg { get; }

    public bool AllowRotation => RotationDeg is 90 or 270;

    public static Result<Placement> Create(
        Guid designId,
        Guid versionId,
        string? designName,
        decimal xCm,
        decimal yCm,
        decimal widthCm,
        decimal heightCm,
        int widthPx,
        int heightPx,
        int rotationDeg)
    {
        if (designId == Guid.Empty || versionId == Guid.Empty)
        {
            return Result<Placement>.Failure(
                ErrorCodes.InvalidRequest,
                "A placement requires a design and a version id.");
        }

        if (xCm < 0 || yCm < 0)
        {
            return Result<Placement>.Failure(
                ErrorCodes.InvalidRequest,
                "Placement coordinates must not be negative.");
        }

        if (widthCm <= 0 || heightCm <= 0 || widthPx < 1 || heightPx < 1)
        {
            return Result<Placement>.Failure(
                ErrorCodes.InvalidRequest,
                "Placement dimensions must be positive.");
        }

        if (rotationDeg is not (0 or 90 or 180 or 270))
        {
            return Result<Placement>.Failure(
                ErrorCodes.InvalidRequest,
                "Rotation must be exactly 0, 90, 180 or 270 degrees.");
        }

        if (designName is { Length: > 200 })
        {
            return Result<Placement>.Failure(
                ErrorCodes.InvalidRequest,
                "Placement display name must be at most 200 characters.");
        }

        return Result<Placement>.Success(new Placement(
            designId,
            versionId,
            designName,
            xCm,
            yCm,
            widthCm,
            heightCm,
            widthPx,
            heightPx,
            rotationDeg));
    }

    public bool IsInside(decimal sheetWidthCm, decimal sheetHeightCm)
        => XCm >= 0
           && YCm >= 0
           && XCm + WidthCm <= sheetWidthCm + 0.000001m
           && YCm + HeightCm <= sheetHeightCm + 0.000001m;
}
