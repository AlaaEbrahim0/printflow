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
    int TargetHeightPx);

/// <summary>An 8-bit single-channel matte, already at the target size.</summary>
public sealed record AlphaMask(byte[] Pixels, int WidthPx, int HeightPx);

/// <summary>
/// Upscales and refines a low-resolution matte to the sharp colour layer's size.
/// Phase 1 is a Lanczos resample with optional feather/threshold; a guided
/// filter can replace it behind this same port.
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
