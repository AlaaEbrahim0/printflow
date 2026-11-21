using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrintSheet.Application.BackgroundRemoval;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Drains queued background-removal jobs on the API side.
///
/// One job at a time, deliberately: the pipeline holds several full-size PNGs in
/// memory and the upscaler runs on a single GPU, so concurrency would only trade
/// memory and GPU contention for throughput that does not exist.
/// </summary>
public sealed class BackgroundRemovalWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<BackgroundRemovalWorker> logger) : BackgroundService
{
    /// <summary>Idle poll interval. A cutout is queued by hand, not in bulk.</summary>
    private static readonly TimeSpan IdleDelay = TimeSpan.FromSeconds(5);

    /// <summary>Pause after a failed pass so a persistent fault cannot spin.</summary>
    private static readonly TimeSpan ErrorDelay = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Background-removal runner started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // A scope per pass: the runner resolves scoped repositories.
                await using var scope = scopeFactory.CreateAsyncScope();
                var runner = scope.ServiceProvider.GetRequiredService<BackgroundRemovalJobRunner>();
                var ran = await runner.RunNextAsync(stoppingToken);
                if (ran is not null)
                {
                    // A job just finished; look again immediately.
                    continue;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Background-removal runner pass failed; retrying shortly.");
                await DelayAsync(ErrorDelay, stoppingToken);
                continue;
            }

            await DelayAsync(IdleDelay, stoppingToken);
        }

        logger.LogInformation("Background-removal runner stopped.");
    }

    private static async Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(delay, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // Shutdown while idling is normal.
        }
    }
}
