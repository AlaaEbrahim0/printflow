using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using PrintSheet.Application.Preflight;

namespace PrintSheet.Infrastructure.Preflight;

public static class PreflightDependencyInjection
{
    /// <summary>
    /// Registers the profile, the codec, every check and every fix. Checks and
    /// fixes are discovered from this assembly so a new rule needs no edit here;
    /// the runner sorts them by code, so registration order never reaches JSON.
    /// </summary>
    public static IServiceCollection AddPreflight(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<PreflightOptions>()
            .Bind(configuration.GetSection(PreflightOptions.SectionName))
            .ValidateOnStart();
        services.AddSingleton<
            Microsoft.Extensions.Options.IValidateOptions<PreflightOptions>,
            PreflightOptionsValidator>();

        services.AddSingleton<IPreflightImageCodec, SkiaPreflightImageCodec>();
        services.AddSingleton<PreflightRunner>();
        services.AddSingleton<PreflightService>();

        foreach (var type in Discover(typeof(IPreflightCheck)))
        {
            services.AddSingleton(typeof(IPreflightCheck), type);
        }

        foreach (var type in Discover(typeof(IPreflightFix)))
        {
            services.AddSingleton(typeof(IPreflightFix), type);
        }

        return services;
    }

    private static IEnumerable<Type> Discover(Type contract)
        => typeof(PreflightDependencyInjection).Assembly
            .GetTypes()
            .Where(type => !type.IsAbstract
                && !type.IsInterface
                && contract.IsAssignableFrom(type))
            .OrderBy(type => type.FullName, StringComparer.Ordinal);
}
