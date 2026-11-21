using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;

namespace PrintSheet.Application.Tests;

public sealed class BackgroundRemovalProviderSelectorTests
{
    private static readonly ImageInput Input = new([1, 2, 3], "image/png", "art.png");

    [Fact]
    public async Task UsesThePrimaryProviderWhenItSucceeds()
    {
        var primary = new StubRemover("poof", _ => Result("poof"));
        var fallback = new StubRemover("withoutbg", _ => Result("withoutbg"));
        var selector = Create(primary, fallback, "poof", "withoutbg");

        var result = await selector.RemoveAsync(Input, CancellationToken.None);

        Assert.Equal("poof", result.Provider);
        Assert.Equal(0, fallback.Calls);
        Assert.Equal("poof", selector.Provider);
    }

    [Theory]
    [InlineData(BackgroundRemovalFailureReason.Unauthorized)]
    [InlineData(BackgroundRemovalFailureReason.PermissionDenied)]
    [InlineData(BackgroundRemovalFailureReason.InsufficientCredits)]
    [InlineData(BackgroundRemovalFailureReason.RateLimited)]
    [InlineData(BackgroundRemovalFailureReason.ProviderUnavailable)]
    [InlineData(BackgroundRemovalFailureReason.Timeout)]
    [InlineData(BackgroundRemovalFailureReason.Unexpected)]
    public async Task FallsBackOnAvailabilityFailures(BackgroundRemovalFailureReason reason)
    {
        var primary = new StubRemover(
            "poof",
            _ => throw new BackgroundRemovalException(reason, "poof", "boom"));
        var fallback = new StubRemover("withoutbg", _ => Result("withoutbg"));
        var selector = Create(primary, fallback, "poof", "withoutbg");

        var result = await selector.RemoveAsync(Input, CancellationToken.None);

        Assert.Equal("withoutbg", result.Provider);
        Assert.Equal(1, fallback.Calls);
    }

    [Fact]
    public async Task NeverFallsBackOnAnInvalidImageBecauseTheBytesAreAtFault()
    {
        var primary = new StubRemover(
            "poof",
            _ => throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                "poof",
                "bad bytes"));
        var fallback = new StubRemover("withoutbg", _ => Result("withoutbg"));
        var selector = Create(primary, fallback, "poof", "withoutbg");

        await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => selector.RemoveAsync(Input, CancellationToken.None));
        Assert.Equal(0, fallback.Calls);
    }

    [Fact]
    public async Task RethrowsWhenNoFallbackIsConfigured()
    {
        var primary = new StubRemover(
            "poof",
            _ => throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.ProviderUnavailable,
                "poof",
                "down"));
        var selector = Create(primary, null, "poof", null);

        await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => selector.RemoveAsync(Input, CancellationToken.None));
    }

    [Fact]
    public async Task HonoursAPerJobProviderOverride()
    {
        var primary = new StubRemover("withoutbg", _ => Result("withoutbg"));
        var fallback = new StubRemover("poof", _ => Result("poof"));
        var selector = Create(primary, fallback, "withoutbg", "poof");

        // The operator asked for Poof on this one job; the configured default must
        // not win, and the override must not be treated as a fallback.
        var result = await selector.RemoveAsync(
            Input,
            CancellationToken.None,
            preferredProvider: "poof");

        Assert.Equal("poof", result.Provider);
        Assert.Equal(0, primary.Calls);
        Assert.Equal(1, fallback.Calls);
        // The reported default is still the configured one.
        Assert.Equal("withoutbg", selector.Provider);
    }

    [Fact]
    public async Task AnOverrideThatIsAlsoTheFallbackSurfacesTheFault()
    {
        var primary = new StubRemover("withoutbg", _ => Result("withoutbg"));
        var overrideProvider = new StubRemover(
            "poof",
            _ => throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.ProviderUnavailable,
                "poof",
                "down"));
        var selector = Create(primary, overrideProvider, "withoutbg", "poof");

        // The override names the configured fallback, so retrying would mean calling
        // the same provider again. The availability fault surfaces instead.
        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => selector.RemoveAsync(
                Input,
                CancellationToken.None,
                preferredProvider: "poof"));

        Assert.Equal(BackgroundRemovalFailureReason.ProviderUnavailable, error.Reason);
        Assert.Equal(0, primary.Calls);
        Assert.Equal(1, overrideProvider.Calls);
    }

    [Fact]
    public async Task AnOverrideFallsBackWhenADifferentFallbackIsConfigured()
    {
        // Default is Poof, the configured fallback is withoutBG, and the operator
        // overrides this job to Poof - the same as the default, so a Poof outage
        // still falls back to withoutBG rather than failing the cutout.
        var primary = new StubRemover(
            "poof",
            _ => throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.ProviderUnavailable,
                "poof",
                "down"));
        var fallback = new StubRemover("withoutbg", _ => Result("withoutbg"));
        var selector = Create(primary, fallback, "poof", "withoutbg");

        var result = await selector.RemoveAsync(
            Input,
            CancellationToken.None,
            preferredProvider: "poof");

        Assert.Equal("withoutbg", result.Provider);
        Assert.Equal(1, fallback.Calls);
    }

    [Fact]
    public async Task AnUnknownOverrideIsAnInputFaultAndDoesNotCallAnyProvider()
    {
        var poof = new StubRemover("poof", _ => Result("poof"));
        var selector = Create(poof, null, "poof", null);

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => selector.RemoveAsync(
                Input,
                CancellationToken.None,
                preferredProvider: "nope"));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
        Assert.False(error.AllowsFallback);
        Assert.Equal(0, poof.Calls);
    }

    [Fact]
    public async Task AnOverrideNamingThePrimaryStillFallsBack()
    {
        var primary = new StubRemover(
            "withoutbg",
            _ => throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.ProviderUnavailable,
                "withoutbg",
                "down"));
        var fallback = new StubRemover("poof", _ => Result("poof"));
        var selector = Create(primary, fallback, "withoutbg", "poof");

        // Explicitly asking for the configured primary must behave exactly like
        // omitting the override: an outage still falls back.
        var result = await selector.RemoveAsync(
            Input,
            CancellationToken.None,
            preferredProvider: "withoutbg");

        Assert.Equal("poof", result.Provider);
        Assert.Equal(1, fallback.Calls);
    }

    [Fact]
    public void RejectsAnUnregisteredProviderName()
    {
        var poof = new StubRemover("poof", _ => Result("poof"));

        var error = Assert.Throws<InvalidOperationException>(
            () => Create(poof, null, "nope", null));

        Assert.Contains("nope", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RejectsAFallbackEqualToThePrimary()
    {
        var poof = new StubRemover("poof", _ => Result("poof"));

        var error = Assert.Throws<InvalidOperationException>(
            () => Create(poof, null, "poof", "poof"));

        Assert.Contains("must differ", error.Message, StringComparison.Ordinal);
    }

    private static BackgroundRemovalResult Result(string provider)
        => new([9], provider, TimeSpan.FromMilliseconds(1));

    private static BackgroundRemovalProviderSelector Create(
        StubRemover primary,
        StubRemover? fallback,
        string defaultProvider,
        string? fallbackProvider)
    {
        var options = Options.Create(
            new BackgroundRemovalOptions
            {
                DefaultProvider = defaultProvider,
                FallbackProvider = fallbackProvider,
            });
        var providers = fallback is null ? [primary] : new[] { primary, fallback };
        return new BackgroundRemovalProviderSelector(
            providers,
            options,
            NullLogger<BackgroundRemovalProviderSelector>.Instance);
    }

    private sealed class StubRemover(
        string provider,
        Func<ImageInput, BackgroundRemovalResult> behavior) : IBackgroundRemover
    {
        public int Calls { get; private set; }

        public string Provider => provider;

        public Task<BackgroundRemovalResult> RemoveAsync(
            ImageInput image,
            CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(behavior(image));
        }
    }
}
