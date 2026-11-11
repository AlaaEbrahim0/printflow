using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// What an operator's manual edit did to the pixels. The file dimensions are
/// measured by the API, so <see cref="CropApplied"/> is checked against the
/// parent instead of being trusted from the request.
/// </summary>
/// <param name="EditedWidthPx">Rendered width; the parent width when uncropped.</param>
/// <param name="EditedHeightPx">Rendered height; the parent height when uncropped.</param>
/// <param name="CropApplied">The operator declared a crop, i.e. a smaller canvas.</param>
public sealed record ManualEditGeometry(
    int EditedWidthPx,
    int EditedHeightPx,
    bool CropApplied)
{
    public static Result<ManualEditGeometry> Create(int widthPx, int heightPx, bool cropApplied)
    {
        if (widthPx < 1 || heightPx < 1)
        {
            return Result<ManualEditGeometry>.Failure(
                ErrorCodes.InvalidRequest,
                "A manual edit result must have positive pixel dimensions.");
        }

        return Result<ManualEditGeometry>.Success(
            new ManualEditGeometry(widthPx, heightPx, cropApplied));
    }
}
