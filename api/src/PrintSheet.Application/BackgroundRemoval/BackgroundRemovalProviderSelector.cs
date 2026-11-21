using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;

namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>
/// Chooses the configured primary provider and falls back only for availability
/// failures. A validation failure caused by our own input is never retried on the
/// other provider: the same bytes would fail there too.
/// </summary>
public sealed class BackgroundRemovalProviderSelector : IBackgroundRemovalService
{
    private readonly IReadOnlyList<IBackgroundRemover> _providers;
    private readonly IBackgroundRemover _primary;
    private readonly IBackgroundRemover? _fallback;
    private readonly ILogger<BackgroundRemovalProviderSelector> _logger;

    public BackgroundRemovalProviderSelector(
        IEnumerable<IBackgroundRemover> providers,
        IOptions<BackgroundRemovalOptions> options,
        ILogger<BackgroundRemovalProviderSelector> logger)
    {
        _logger = logger;
        _providers = providers.ToArray();
        var configured = options.Value;

        _primary = Find(configured.DefaultProvider)
            ?? throw new InvalidOperationException(
                $"BackgroundRemoval:DefaultProvider '{configured.DefaultProvider}' has no registered adapter.");

        _fallback = configured.FallbackProvider is { Length: > 0 } name
            ? Find(name) ?? throw new InvalidOperationException(
                $"BackgroundRemoval:FallbackProvider '{name}' has no registered adapter.")
            : null;

        if (_fallback is not null
            && string.Equals(_fallback.Provider, _primary.Provider, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "BackgroundRemoval:FallbackProvider must differ from DefaultProvider.");
        }
    }

    public string Provider => _primary.Provider;

    public IReadOnlyList<IBackgroundRemover> Providers => _providers;

    public async Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken,
        string? preferredProvider = null)
    {
        var primary = Resolve(preferredProvider);

        try
        {
            return await primary.RemoveAsync(image, cancellationToken);
        }
        catch (BackgroundRemovalException exception) when (exception.AllowsFallback && _fallback is not null)
        {
            // The override replaces the primary for this one job; the availability
            // fallback policy still applies, so a provider outage does not fail a
            // cutout the operator could have had. When the override *is* the
            // configured fallback there is nowhere left to go, so surface the fault
            // rather than silently retrying the same provider.
            if (string.Equals(primary.Provider, _fallback.Provider, StringComparison.OrdinalIgnoreCase))
            {
                throw;
            }

            _logger.LogWarning(
                "Background removal provider {Provider} failed ({Reason}); falling back to {Fallback}.",
                primary.Provider,
                exception.Reason,
                _fallback.Provider);

            return await _fallback.RemoveAsync(image, cancellationToken);
        }
    }

    /// <summary>
    /// The adapter for a per-job override, or the configured primary when none was
    /// requested. An unknown name is an input fault, not an availability fault: the
    /// API validates overrides when the job is queued, so reaching this with a
    /// bogus name means the request path and this lookup disagree.
    /// </summary>
    private IBackgroundRemover Resolve(string? preferredProvider)
    {
        if (string.IsNullOrWhiteSpace(preferredProvider))
        {
            return _primary;
        }

        return Find(preferredProvider)
            ?? throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                preferredProvider,
                $"The requested background-removal provider '{preferredProvider}' is not configured.");
    }

    private IBackgroundRemover? Find(string name)
        => _providers.FirstOrDefault(
            provider => string.Equals(provider.Provider, name, StringComparison.OrdinalIgnoreCase));
}
