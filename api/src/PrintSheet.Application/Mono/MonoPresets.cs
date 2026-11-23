namespace PrintSheet.Application.Mono;

/// <summary>
/// The preset names the worker understands, mirrored here so the API can reject
/// an unknown name with a clear message instead of queueing a job that will fail.
/// </summary>
/// <remarks>
/// The worker owns the presets and their parameters — the API deliberately does
/// not duplicate the numbers, because a preset tuned in the worker must not need
/// an API change. This list is only the vocabulary.
/// </remarks>
public static class MonoPresets
{
    public const string Text = "text";
    public const string Logo = "logo";
    public const string Illustration = "illustration";
    public const string CleanOnly = "clean-only";

    public static readonly string[] All = [Text, Logo, Illustration, CleanOnly];
}
