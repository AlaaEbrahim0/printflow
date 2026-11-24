using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;

namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>
/// Chooses the configured primary provider and falls back only for availability
/// failures. A validation failure caused by our own input is never retried on the
/// other provider: the same bytes would fail there too.
///
/// <c>auto</c> is a selection mode, not an adapter: it probes the deterministic
/// Solid remover first, then the local ML service, then Poof. The configured
/// fallback still governs explicit providers.
/// </summary>
public sealed class BackgroundRemovalProviderSelector : IBackgroundRemovalService
{
    private static readonly string[] AutoChain =
        [BackgroundRemovalProviders.WithoutBg, BackgroundRemovalProviders.Poof];

    private readonly IReadOnlyList<IBackgroundRemover> _providers;
    private readonly IBackgroundRemover? _primary;
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

        _primary = IsAuto(configured.DefaultProvider)
            ? null
            : Find(configured.DefaultProvider)
                ?? throw new InvalidOperationException(
                    $"BackgroundRemoval:DefaultProvider '{configured.DefaultProvider}' has no registered adapter.");

        _fallback = configured.FallbackProvider is { Length: > 0 } name
            ? Find(name) ?? throw new InvalidOperationException(
                $"BackgroundRemoval:FallbackProvider '{name}' has no registered adapter.")
            : null;

        if (_fallback is not null
            && _primary is not null
            && string.Equals(_fallback.Provider, _primary.Provider, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "BackgroundRemoval:FallbackProvider must differ from DefaultProvider.");
        }
    }

    public string Provider => _primary?.Provider ?? BackgroundRemovalProviders.Auto;

    public IReadOnlyList<IBackgroundRemover> Providers => _providers;

    public async Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken,
        string? preferredProvider = null)
    {
        var requested = string.IsNullOrWhiteSpace(preferredProvider)
            ? Provider
            : preferredProvider;

        if (IsAuto(requested))
        {
            return await RemoveAutoAsync(image, cancellationToken);
        }

        var primary = Resolve(requested);
        await EnsureApplicableAsync(primary, image, cancellationToken);

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
    /// Solid when the border analysis says it is safe, then the local model, then
    /// Poof. The order is fixed here because it is the point of the mode: no
    /// operator should have to configure a chain. Availability faults move down
    /// the chain; an input fault still stops immediately.
    /// </summary>
    private async Task<BackgroundRemovalResult> RemoveAutoAsync(
        ImageInput image,
        CancellationToken cancellationToken)
    {
        if (Find(BackgroundRemovalProviders.Solid) is { } solid)
        {
            var applicability = await ProbeAsync(solid, image, cancellationToken);
            if (applicability?.IsApplicable != false)
            {
                _logger.LogInformation(
                    "auto background removal chose {Provider}: borderUniformity={Uniformity:F3} "
                    + "borderForegroundRatio={ForegroundRatio:F3} backgroundFraction={BackgroundFraction:F3}",
                    solid.Provider,
                    applicability?.BorderUniformity ?? 0,
                    applicability?.BorderForegroundRatio ?? 0,
                    applicability?.BackgroundFraction ?? 0);

                return await solid.RemoveAsync(image, cancellationToken);
            }

            _logger.LogInformation(
                "auto background removal skipped solid: {Reasons}",
                string.Join(" ", applicability.Reasons));
        }

        BackgroundRemovalException? lastFailure = null;
        foreach (var name in AutoChain)
        {
            if (Find(name) is not { } provider)
            {
                continue;
            }

            try
            {
                var result = await provider.RemoveAsync(image, cancellationToken);
                _logger.LogInformation(
                    "auto background removal chose {Provider}.", provider.Provider);
                return result;
            }
            catch (BackgroundRemovalException exception) when (exception.AllowsFallback)
            {
                lastFailure = exception;
                _logger.LogWarning(
                    "auto background removal provider {Provider} was unavailable ({Reason}); trying the next one.",
                    provider.Provider,
                    exception.Reason);
            }
        }

        throw lastFailure ?? new BackgroundRemovalException(
            BackgroundRemovalFailureReason.ProviderUnavailable,
            BackgroundRemovalProviders.Auto,
            "No background-removal provider is available.");
    }

    /// <summary>
    /// Explicit <c>solid</c> must fail loudly when it cannot work: silently
    /// running an ML model would defeat the operator's choice and spend credits.
    /// </summary>
    private async Task EnsureApplicableAsync(
        IBackgroundRemover provider,
        ImageInput image,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(provider.Provider, BackgroundRemovalProviders.Solid, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var applicability = await ProbeAsync(provider, image, cancellationToken);
        if (applicability is { IsApplicable: false })
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                provider.Provider,
                "Solid background removal is not applicable: "
                + string.Join(" ", applicability.Reasons)
                + " Choose withoutbg or poof, or clean the background first.");
        }
    }

    private static async Task<BackgroundRemovalApplicability?> ProbeAsync(
        IBackgroundRemover provider,
        ImageInput image,
        CancellationToken cancellationToken)
    {
        if (provider is IBackgroundRemovalApplicability probe)
        {
            return await probe.CheckApplicabilityAsync(image, cancellationToken);
        }

        return null;
    }

    private static bool IsAuto(string? name)
        => string.Equals(name, BackgroundRemovalProviders.Auto, StringComparison.OrdinalIgnoreCase);

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
            return _primary
                ?? throw new BackgroundRemovalException(
                    BackgroundRemovalFailureReason.InvalidImage,
                    BackgroundRemovalProviders.Auto,
                    "No explicit background-removal provider was requested.");
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
