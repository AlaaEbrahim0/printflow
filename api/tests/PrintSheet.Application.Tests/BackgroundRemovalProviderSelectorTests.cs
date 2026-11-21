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
