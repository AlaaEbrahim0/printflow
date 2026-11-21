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
        CancellationToken cancellationToken)
    {
        try
        {
            return await _primary.RemoveAsync(image, cancellationToken);
        }
        catch (BackgroundRemovalException exception) when (exception.AllowsFallback && _fallback is not null)
        {
            _logger.LogWarning(
                "Background removal provider {Provider} failed ({Reason}); falling back to {Fallback}.",
                _primary.Provider,
                exception.Reason,
                _fallback.Provider);

            return await _fallback.RemoveAsync(image, cancellationToken);
        }
    }

    private IBackgroundRemover? Find(string name)
        => _providers.FirstOrDefault(
            provider => string.Equals(provider.Provider, name, StringComparison.OrdinalIgnoreCase));
}
