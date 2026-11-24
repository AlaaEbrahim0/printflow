namespace PrintSheet.Application.Abstractions;

/// <summary>Crop step, implemented by the worker that owns auto-trim.</summary>
public interface IImageCropper
{
    Task<byte[]> CropAsync(ImageInput image, CancellationToken cancellationToken);
}

/// <summary>Enhancement step, implemented by the existing Real-ESRGAN worker.</summary>
public interface IImageUpscaler
{
    Task<byte[]> UpscaleAsync(ImageInput image, CancellationToken cancellationToken);
}

/// <summary>One refinement pass request: a low-resolution matte and its target size.</summary>
public sealed record AlphaRefinement(
    byte[] CutoutRgbaPng,
    int TargetWidthPx,
    int TargetHeightPx,
    bool PreserveSoftEdge = false);

/// <summary>An 8-bit single-channel matte, already at the target size.</summary>
public sealed record AlphaMask(byte[] Pixels, int WidthPx, int HeightPx);

/// <summary>
/// What one enclosed-background pass did. The counts reach the job metadata so an
/// operator can tell "nothing was enclosed" from "the pass refused this design".
/// </summary>
/// <param name="PngBytes">The input bytes unchanged when <paramref name="Applied"/> is false.</param>
/// <param name="Applied">False when the pass declined to touch the image.</param>
/// <param name="SkippedReason">Stable code such as <c>no-background-key</c>; null when applied.</param>
/// <param name="RegionsCleared">Enclosed regions turned transparent.</param>
/// <param name="PixelsCleared">Pixels whose alpha changed, ramps included.</param>
public sealed record EnclosedBackgroundOutcome(
    byte[] PngBytes,
    bool Applied,
    string? SkippedReason,
    int RegionsCleared,
    int PixelsCleared);

/// <summary>
/// Upscales and refines a low-resolution matte to the sharp colour layer's size.
/// Phase 1 is a bicubic (Mitchell) resample with optional feather/threshold; a
/// guided filter can replace it behind this same port.
/// </summary>
public interface IAlphaRefiner
{
    Task<AlphaMask> RefineAsync(AlphaRefinement refinement, CancellationToken cancellationToken);
}

/// <summary>Recombines the upscaled RGB layer with the refined alpha.</summary>
public interface IAlphaCompositor
{
    Task<byte[]> ApplyAlphaAsync(byte[] rgbPng, AlphaMask alpha, CancellationToken cancellationToken);
}

/// <summary>
/// Removes the background colour that remains mixed into semi-transparent edge
/// pixels. Runs after the compositor because the provider's RGB is discarded by
/// the pipeline; only a background-colour hint from the remover can drive it.
/// </summary>
public interface IBackgroundDecontaminator
{
    Task<byte[]> DecontaminateAsync(
        byte[] rgbaPng,
        RgbColor backgroundColor,
        CancellationToken cancellationToken);
}

/// <summary>
/// Clears background-coloured regions that the matte left opaque because artwork
/// encloses them (the counters of <c>o</c>, <c>B</c>, <c>8</c>, the gaps inside a
/// badge). Providers only reach background connected to the frame edge, so these
/// survive as opaque islands of the background colour.
///
/// Optional per job: it is only correct when those enclosed areas really are
/// background, and a design whose ink matches the background colour would lose
/// the ink instead. Runs after the compositor so the ramp it creates is
/// decontaminated by the stage that follows.
/// </summary>
public interface IEnclosedBackgroundCleaner
{
    Task<EnclosedBackgroundOutcome> ClearAsync(
        byte[] rgbaPng,
        RgbColor? backgroundColor,
        CancellationToken cancellationToken);
}
