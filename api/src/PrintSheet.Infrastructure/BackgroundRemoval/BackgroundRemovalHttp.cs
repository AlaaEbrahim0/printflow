using System.Net;
using Polly;
using Polly.Timeout;
using PrintSheet.Application.BackgroundRemoval;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>Maps HTTP outcomes to the application's failure reasons.</summary>
internal static class BackgroundRemovalHttp
{
    public static async Task<BackgroundRemovalException> FromResponseAsync(
        string provider,
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        var detail = await SafeDetailAsync(response, cancellationToken);
        var reason = response.StatusCode switch
        {
            HttpStatusCode.Unauthorized => BackgroundRemovalFailureReason.Unauthorized,
            HttpStatusCode.PaymentRequired => BackgroundRemovalFailureReason.InsufficientCredits,
            HttpStatusCode.Forbidden => BackgroundRemovalFailureReason.PermissionDenied,
            HttpStatusCode.TooManyRequests => BackgroundRemovalFailureReason.RateLimited,
            HttpStatusCode.RequestEntityTooLarge => BackgroundRemovalFailureReason.InvalidImage,
            HttpStatusCode.UnsupportedMediaType => BackgroundRemovalFailureReason.InvalidImage,
            HttpStatusCode.UnprocessableEntity => BackgroundRemovalFailureReason.InvalidImage,
            HttpStatusCode.BadRequest => BackgroundRemovalFailureReason.InvalidImage,
            HttpStatusCode.NotImplemented => BackgroundRemovalFailureReason.ProviderUnavailable,
            HttpStatusCode.BadGateway => BackgroundRemovalFailureReason.ProviderUnavailable,
            HttpStatusCode.ServiceUnavailable => BackgroundRemovalFailureReason.ProviderUnavailable,
            HttpStatusCode.GatewayTimeout => BackgroundRemovalFailureReason.ProviderUnavailable,
            _ when (int)response.StatusCode >= 500 => BackgroundRemovalFailureReason.ProviderUnavailable,
            _ => BackgroundRemovalFailureReason.Unexpected,
        };

        return new BackgroundRemovalException(
            reason,
            provider,
            $"{provider} returned {(int)response.StatusCode} {response.ReasonPhrase}{detail}.");
    }

    public static BackgroundRemovalException Timeout(string provider, Exception exception)
        => new(BackgroundRemovalFailureReason.Timeout, provider, $"{provider} timed out.", exception);

    public static BackgroundRemovalException Unavailable(string provider, Exception exception)
        => new(
            BackgroundRemovalFailureReason.ProviderUnavailable,
            provider,
            $"{provider} could not be reached.",
            exception);

    /// <summary>
    /// Maps a rejection raised by the resilience pipeline rather than by HTTP. The
    /// standard handler does not throw <see cref="OperationCanceledException"/> or
    /// <see cref="HttpRequestException"/> for these: an attempt timeout surfaces as
    /// <c>Polly.Timeout.TimeoutRejectedException</c> and an open circuit as
    /// <c>Polly.CircuitBreaker.BrokenCircuitException</c>. Both mean "try the other
    /// provider", so they must not escape the port as unknown exceptions.
    /// </summary>
    public static BackgroundRemovalException Rejected(string provider, ExecutionRejectedException exception)
        => exception is TimeoutRejectedException
            ? new BackgroundRemovalException(
                BackgroundRemovalFailureReason.Timeout,
                provider,
                $"{provider} timed out.",
                exception)
            : new BackgroundRemovalException(
                BackgroundRemovalFailureReason.ProviderUnavailable,
                provider,
                $"{provider} is temporarily unavailable.",
                exception);

    private static async Task<string> SafeDetailAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        try
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (string.IsNullOrWhiteSpace(body))
            {
                return string.Empty;
            }

            // Error bodies are short JSON; keep the message bounded and never log
            // the image response itself.
            var trimmed = body.ReplaceLineEndings(" ").Trim();
            return trimmed.Length <= 240 ? $" ({trimmed})" : $" ({trimmed[..240]}…)";
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return string.Empty;
        }
    }
}
