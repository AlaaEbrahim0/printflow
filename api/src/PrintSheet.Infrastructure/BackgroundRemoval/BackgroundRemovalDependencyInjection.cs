using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Application.Services;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>One composition root for every background-removal adapter.</summary>
public static class BackgroundRemovalDependencyInjection
{
    // CPU inference on a single image; the framework's 10 s attempt default is far
    // too tight for a 4 GB workstation.
    private static readonly TimeSpan WithoutBgAttemptTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan WithoutBgTotalTimeout = TimeSpan.FromSeconds(120);

    // Cloud call: the provider's own processing budget plus upload time.
    private static readonly TimeSpan PoofAttemptTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan PoofTotalTimeout = TimeSpan.FromSeconds(120);

    // Cropping is pure CPU on one image and returns in milliseconds to seconds.
    private static readonly TimeSpan CropAttemptTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan CropTotalTimeout = TimeSpan.FromSeconds(180);

    // One Real-ESRGAN run on a CPU tile set is minutes, not seconds.
    private static readonly TimeSpan UpscaleAttemptTimeout = TimeSpan.FromSeconds(300);
    private static readonly TimeSpan UpscaleTotalTimeout = TimeSpan.FromSeconds(600);

    public static IServiceCollection AddBackgroundRemoval(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<BackgroundRemovalOptions>()
            .Bind(configuration.GetSection(BackgroundRemovalOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.AddOptions<WithoutBgOptions>()
            .Bind(configuration.GetSection(WithoutBgOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.AddOptions<PoofOptions>()
            .Bind(configuration.GetSection(PoofOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.AddOptions<PrepareWorkerOptions>()
            .Bind(configuration.GetSection(PrepareWorkerOptions.SectionName))
            .PostConfigure(options => options.WorkerKey ??= configuration["Worker:Key"])
            .ValidateDataAnnotations()
            .ValidateOnStart();

        AddAdapter<WithoutBgBackgroundRemover, WithoutBgOptions>(
            services,
            WithoutBgAttemptTimeout,
            WithoutBgTotalTimeout);
        AddAdapter<PoofBackgroundRemover, PoofOptions>(
            services,
            PoofAttemptTimeout,
            PoofTotalTimeout);
        AddAdapter<PrepareWorkerCropper, PrepareWorkerOptions>(
            services,
            CropAttemptTimeout,
            CropTotalTimeout);
        AddAdapter<PrepareWorkerUpscaler, PrepareWorkerOptions>(
            services,
            UpscaleAttemptTimeout,
            UpscaleTotalTimeout);

        services.AddHttpClient("withoutbg-health");

        services.AddTransient<IBackgroundRemover>(provider =>
            provider.GetRequiredService<PoofBackgroundRemover>());
        services.AddTransient<IBackgroundRemover>(provider =>
            provider.GetRequiredService<WithoutBgBackgroundRemover>());

        services.AddTransient<BackgroundRemovalProviderSelector>();
        services.AddTransient<IBackgroundRemovalService>(provider =>
            new BoundedMatteProvider(
                provider.GetRequiredService<BackgroundRemovalProviderSelector>(),
                provider.GetRequiredService<IOptions<BackgroundRemovalOptions>>(),
                provider.GetRequiredService<IOptions<WithoutBgOptions>>(),
                provider.GetRequiredService<IOptions<PoofOptions>>(),
                provider.GetRequiredService<ILogger<BoundedMatteProvider>>()));
        // Resolved through their typed clients, like the providers: a plain
        // AddTransient would inject a bare HttpClient with no base address and
        // every call would fail at runtime.
        services.AddTransient<IImageCropper>(provider =>
            provider.GetRequiredService<PrepareWorkerCropper>());
        services.AddTransient<IImageUpscaler>(provider =>
            provider.GetRequiredService<PrepareWorkerUpscaler>());
        services.AddTransient<IAlphaRefiner, SkiaAlphaRefiner>();
        services.AddTransient<IAlphaCompositor, SkiaAlphaCompositor>();
        services.AddTransient<IBackgroundRemovalPipeline, BackgroundRemovalPipeline>();

        // The runner is scoped because it reads repositories; the hosted service
        // opens a scope per pass so each job gets a fresh unit of work.
        services.AddScoped<BackgroundRemovalJobRunner>();
        services.AddScoped<IJobCompletionPort, JobCompletionAdapter>();

        return services;
    }

    /// <summary>
    /// One typed client per adapter: base address from its own option set plus the
    /// standard resilience pipeline with timeouts that fit the work being done.
    /// </summary>
    private static void AddAdapter<TClient, TOptions>(
        IServiceCollection services,
        TimeSpan attemptTimeout,
        TimeSpan totalTimeout)
        where TClient : class
        where TOptions : class, IHttpClientEndpointOptions
        => services
            .AddHttpClient<TClient>((provider, client) =>
            {
                var baseUrl = provider.GetRequiredService<IOptions<TOptions>>().Value.BaseUrl;
                client.BaseAddress = new Uri(baseUrl.EndsWith('/') ? baseUrl : baseUrl + "/");
            })
            .AddStandardResilienceHandler(resilience =>
                Configure(resilience, attemptTimeout, totalTimeout));

    private static void Configure(
        HttpStandardResilienceOptions resilience,
        TimeSpan attemptTimeout,
        TimeSpan totalTimeout)
    {
        resilience.AttemptTimeout.Timeout = attemptTimeout;
        resilience.TotalRequestTimeout.Timeout = totalTimeout;

        // Every call here spends real work: a billed Poof credit, an exclusive GPU
        // minute, or a full CPU inference. A retry after an attempt timeout can
        // duplicate that work, so retries are limited to safe methods. The selector
        // absorbs transient provider faults by falling back, and the pipeline as a
        // whole can be re-run. Timeouts and the circuit breaker still apply.
        resilience.Retry.DisableForUnsafeHttpMethods();

        // Polly requires the sampling window to cover at least two attempts.
        resilience.CircuitBreaker.SamplingDuration = TimeSpan.FromTicks(
            Math.Max(TimeSpan.FromSeconds(60).Ticks, attemptTimeout.Ticks * 2));
    }
}
