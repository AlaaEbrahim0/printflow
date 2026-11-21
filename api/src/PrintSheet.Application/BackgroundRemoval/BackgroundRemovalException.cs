namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>Why a provider call failed, in application terms.</summary>
public enum BackgroundRemovalFailureReason
{
    Unauthorized,
    PermissionDenied,
    InsufficientCredits,
    RateLimited,
    InvalidImage,
    ProviderUnavailable,
    Timeout,
    Unexpected,
}

/// <summary>
/// Domain-level failure raised by an adapter. HTTP status codes stay inside
/// Infrastructure; this type is what the application and the fallback selector see.
/// </summary>
public sealed class BackgroundRemovalException : Exception
{
    public BackgroundRemovalException(
        BackgroundRemovalFailureReason reason,
        string provider,
        string message,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Reason = reason;
        Provider = provider;
    }

    public BackgroundRemovalFailureReason Reason { get; }

    public string Provider { get; }

    /// <summary>
    /// True when another provider could plausibly succeed. Input faults
    /// (<see cref="BackgroundRemovalFailureReason.InvalidImage"/>) never qualify:
    /// the same bytes would fail everywhere.
    /// </summary>
    public bool AllowsFallback => Reason != BackgroundRemovalFailureReason.InvalidImage;
}
