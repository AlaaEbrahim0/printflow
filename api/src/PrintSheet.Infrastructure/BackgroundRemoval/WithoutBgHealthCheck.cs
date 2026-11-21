using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Readiness of the self-hosted withoutBG container. Tagged <c>dependency</c>, so
/// the API's own <c>/healthz</c> does not turn 503 when the cutout service is down.
/// </summary>
public sealed class WithoutBgHealthCheck(
    IHttpClientFactory httpClientFactory,
    IOptions<WithoutBgOptions> options) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        using var client = httpClientFactory.CreateClient("withoutbg-health");
        // Same normalisation as the typed clients: without the trailing slash a
        // base URL that ends in a path segment would drop that segment.
        var baseUrl = options.Value.BaseUrl;
        client.BaseAddress = new Uri(baseUrl.EndsWith('/') ? baseUrl : baseUrl + "/");
        client.Timeout = TimeSpan.FromSeconds(5);

        try
        {
            using var response = await client.GetAsync("ready", cancellationToken);
            return response.IsSuccessStatusCode
                ? HealthCheckResult.Healthy("withoutBG model is loaded.")
                : HealthCheckResult.Unhealthy(
                    $"withoutBG readiness returned {(int)response.StatusCode}.");
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
        {
            return HealthCheckResult.Unhealthy("withoutBG is not reachable.", exception);
        }
    }
}
