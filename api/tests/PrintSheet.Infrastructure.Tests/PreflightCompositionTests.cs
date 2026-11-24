using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Preflight;
using PrintSheet.Infrastructure.Preflight;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// Composition for preflight: the checks and fixes are discovered from the
/// assembly, so these tests prove the discovery finds them and that a bad
/// profile fails at startup rather than on the first cut-out.
/// </summary>
public sealed class PreflightCompositionTests
{
    [Fact]
    public void ResolvesTheServiceAndDiscoversEveryRule()
    {
        using var provider = Build();

        Assert.IsType<SkiaPreflightImageCodec>(
            provider.GetRequiredService<IPreflightImageCodec>());
        Assert.NotNull(provider.GetRequiredService<PreflightService>());

        // A new rule only needs a class; if discovery breaks, every check silently
        // disappears and the report says "pass" for a broken file.
        Assert.Equal(15, provider.GetServices<IPreflightCheck>().Count());
        Assert.Equal(5, provider.GetServices<IPreflightFix>().Count());
        Assert.Equal(
            15,
            provider.GetServices<IPreflightCheck>().Select(check => check.Code).Distinct().Count());
    }

    [Fact]
    public void BindsTheProfileFromConfiguration()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["Preflight:Profile:MinimumDpi"] = "150",
                ["Preflight:Profile:MinimumStrokeMm"] = "0.4",
                ["Preflight:Profile:ContrastOpacities:0"] = "0.5",
            });

        var profile = provider.GetRequiredService<IOptions<PreflightOptions>>().Value.Profile;

        Assert.Equal(150, profile.MinimumDpi);
        Assert.Equal(0.4, profile.MinimumStrokeMm);
        Assert.Equal([0.5], profile.EffectiveContrastOpacities);
    }

    [Fact]
    public void FailsFastOnAnIncoherentProfile()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["Preflight:Profile:MinimumDpi"] = "400",
                ["Preflight:Profile:RecommendedDpi"] = "300",
            });

        var error = Assert.Throws<OptionsValidationException>(
            () => provider.GetRequiredService<IOptions<PreflightOptions>>().Value);
        Assert.Contains("RecommendedDpi", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void FailsFastOnAnUnknownFixName()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["Preflight:EnabledFixes:0"] = "not-a-fix",
            });

        var error = Assert.Throws<OptionsValidationException>(
            () => provider.GetRequiredService<IOptions<PreflightOptions>>().Value);
        Assert.Contains("not-a-fix", error.Message, StringComparison.Ordinal);
    }

    private static ServiceProvider Build(Dictionary<string, string?>? values = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(values ?? new Dictionary<string, string?>())
            .Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddPreflight(configuration);
        return services.BuildServiceProvider();
    }
}
