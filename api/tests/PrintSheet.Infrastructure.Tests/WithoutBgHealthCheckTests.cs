using System.Net;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using PrintSheet.Infrastructure.BackgroundRemoval;

namespace PrintSheet.Infrastructure.Tests;

public sealed class WithoutBgHealthCheckTests
{
    [Fact]
    public async Task ReportsHealthyWhenReadinessSucceeds()
    {
        var result = await Check(new StubHandler((_, _) => new HttpResponseMessage(HttpStatusCode.OK)));

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }

    [Fact]
    public async Task ReportsUnhealthyWhenTheModelIsStillLoading()
    {
        var result = await Check(
            new StubHandler((_, _) => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
    }

    [Fact]
    public async Task ReportsUnhealthyWhenTheServiceIsUnreachable()
    {
        var result = await Check(
            new StubHandler((_, _) => throw new HttpRequestException("connection refused")));

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.NotNull(result.Exception);
    }

    private static Task<HealthCheckResult> Check(StubHandler handler)
    {
        var check = new WithoutBgHealthCheck(
            new StubFactory(handler),
            Options.Create(new WithoutBgOptions { BaseUrl = "http://withoutbg.test/" }));

        return check.CheckHealthAsync(new HealthCheckContext());
    }

    private sealed class StubFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class StubHandler(
        Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(respond(request, cancellationToken));
    }
}
