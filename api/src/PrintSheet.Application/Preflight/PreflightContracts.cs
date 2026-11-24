using PrintSheet.Domain.Common;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Application.Preflight;

/// <summary>
/// Decoded pixels plus the PNG facts that are not visible in the pixel buffer.
/// Metadata is kept on the image so the fixes that repair it (DPI, sRGB) do not
/// need to re-encode or re-decode behind the codec's back.
/// </summary>
public sealed record PreflightImage(
    byte[] Pixels,
    int Width,
    int Height,
    bool HasAlphaChannel,
    int BitDepth,
    bool HasSrgbProfile,
    int? DpiX,
    int? DpiY)
{
    public int PixelCount => Width * Height;
}

public sealed class PreflightContext
{
    private readonly Lazy<PreflightAnalysis> _analysis;

    public PreflightContext(
        PreflightImage image,
        PrintSpec spec,
        PreflightProfile profile,
        CancellationToken cancellationToken)
    {
        Image = image;
        Spec = spec;
        Profile = profile;
        CancellationToken = cancellationToken;
        _analysis = new Lazy<PreflightAnalysis>(
            () => PreflightAnalysis.Build(image, cancellationToken));
    }

    public PreflightImage Image { get; }

    public PrintSpec Spec { get; }

    public PreflightProfile Profile { get; }

    public CancellationToken CancellationToken { get; }

    public PreflightAnalysis Analysis => _analysis.Value;

    public double PixelsPerMm => Spec.Dpi / 25.4d;

    public double PixelsPerMmSquared => PixelsPerMm * PixelsPerMm;
}

public sealed record PreflightCheckResult(
    IReadOnlyList<PreflightFinding> Findings,
    IReadOnlyList<PreflightMetric> Metrics)
{
    public static PreflightCheckResult None { get; } = new([], []);

    public static PreflightCheckResult Finding(
        PreflightFinding finding,
        params PreflightMetric[] metrics)
        => new([finding], metrics);

    public static PreflightCheckResult Pass(params PreflightMetric[] metrics)
        => new([], metrics);
}

/// <summary>
/// One rule. Checks are discovered from DI and run in code order, so the report
/// is byte-stable regardless of assembly scan order.
/// </summary>
public interface IPreflightCheck
{
    string Code { get; }

    PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken);
}

/// <summary>
/// A repair for one or more finding codes. Every fix is opt-in: the cut-out and
/// the default endpoint run report-only.
/// </summary>
public interface IPreflightFix
{
    string Code { get; }

    string Description { get; }

    /// <summary>Finding codes this fix resolves. It runs only when one is present.</summary>
    IReadOnlyCollection<string> Addresses { get; }

    PreflightImage Apply(
        PreflightImage image,
        PreflightContext context,
        CancellationToken cancellationToken);
}

public interface IPreflightImageCodec
{
    PreflightImage Decode(byte[] png);

    byte[] Encode(PreflightImage image);
}

/// <summary>Expected, user-visible preflight failure (bad upload, unknown profile).</summary>
public sealed class PreflightException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    public static PreflightException Unsupported(string message)
        => new(ErrorCodes.UnsupportedImage, message);

    public static PreflightException Invalid(string message)
        => new(ErrorCodes.InvalidRequest, message);
}

public sealed record PreflightOutcome(
    PreflightReport Report,
    byte[]? FixedPng,
    string Json);
