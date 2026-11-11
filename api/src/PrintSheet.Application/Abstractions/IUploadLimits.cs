namespace PrintSheet.Application.Abstractions;

/// <summary>
/// The configured upload limits. Intake owns the defaults; the manual-edit
/// upload reads the same configured instance so a raised limit applies to both
/// and neither path repeats a magic number.
/// </summary>
public interface IUploadLimits
{
    long MaxUploadBytes { get; }

    int MaxDimensionPx { get; }
}
