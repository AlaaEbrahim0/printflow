using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Application.Services;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.Tests;

public sealed class BackgroundRemovalJobRunnerTests
{
    private static readonly byte[] SourcePng = [1, 2, 3];
    private static readonly byte[] ResultPng = [9, 9, 9];

    [Fact]
    public async Task CompletesAQueuedJobWithThePipelineResult()
    {
        var harness = Harness.Create();

        var ran = await harness.Runner.RunNextAsync(CancellationToken.None);

        Assert.Equal(harness.Job.Id, ran);
        Assert.Equal(1, harness.Pipeline.Calls);
        Assert.Equal(ResultPng, harness.Files.Written[harness.Job.OutputPath!].ToArray());
        Assert.True(harness.Completion.Completed);
        Assert.False(harness.Completion.Failed);
    }

    [Fact]
    public async Task ForwardsTheProviderOverrideStoredOnTheJob()
    {
        var harness = Harness.Create(parametersJson: """{"provider":"poof"}""");

        await harness.Runner.RunNextAsync(CancellationToken.None);

        // The endpoint validates the override and stores it; the runner must pass it
        // on, otherwise every job silently runs on the configured default.
        Assert.Equal("poof", harness.Pipeline.LastPreferredProvider);
    }

    [Fact]
    public async Task UsesTheConfiguredDefaultWhenNoOverrideWasGiven()
    {
        var harness = Harness.Create();

        await harness.Runner.RunNextAsync(CancellationToken.None);

        Assert.Null(harness.Pipeline.LastPreferredProvider);
    }

    [Fact]
    public async Task ClaimsOnlyTheCutoutCapability()
    {
        var harness = Harness.Create();

        await harness.Runner.RunNextAsync(CancellationToken.None);

        // Claiming Image here would race the Python worker for the same job.
        Assert.Equal([JobCapability.Cutout], harness.Queue.LastCapabilities);
    }

    [Fact]
    public async Task ReportsTheProviderAndDimensionsInTheCompletionMetadata()
    {
        var harness = Harness.Create();

        await harness.Runner.RunNextAsync(CancellationToken.None);

        var metadata = harness.Completion.Result!.Value.GetProperty("metadata");
        Assert.Equal("withoutbg", metadata.GetProperty("provider").GetString());
        Assert.Equal(400, metadata.GetProperty("widthPx").GetInt32());
        Assert.Equal(200, metadata.GetProperty("heightPx").GetInt32());
        // hasAlpha is left to the completion service, which inspects the file. The
        // runner must not assert transparency it has not verified.
        Assert.False(metadata.TryGetProperty("hasAlpha", out _));
    }

    [Fact]
    public async Task FailsTheJobWhenTheProviderFails()
    {
        var harness = Harness.Create();
        harness.Pipeline.Throws = new BackgroundRemovalException(
            BackgroundRemovalFailureReason.ProviderUnavailable,
            "withoutbg",
            "The provider is unreachable.");

        await harness.Runner.RunNextAsync(CancellationToken.None);

        Assert.True(harness.Completion.Failed);
        Assert.False(harness.Completion.Completed);
        Assert.Empty(harness.Files.Written);
        // An availability failure may succeed later, so it stays retryable.
        Assert.True(harness.Completion.Error!.Retryable);
    }

    [Fact]
    public async Task DoesNotRetryAnInputFault()
    {
        var harness = Harness.Create();
        harness.Pipeline.Throws = new BackgroundRemovalException(
            BackgroundRemovalFailureReason.InvalidImage,
            "withoutbg",
            "The image cannot be decoded.");

        await harness.Runner.RunNextAsync(CancellationToken.None);

        Assert.True(harness.Completion.Failed);
        Assert.False(harness.Completion.Error!.Retryable);
    }

    [Fact]
    public async Task FailsTheJobWhenTheDesignIsGone()
    {
        var harness = Harness.Create(designFound: false);

        await harness.Runner.RunNextAsync(CancellationToken.None);

        Assert.True(harness.Completion.Failed);
        Assert.Equal(0, harness.Pipeline.Calls);
        Assert.Equal(ErrorCodes.DesignNotFound, harness.Completion.Error!.Code);
    }

    [Fact]
    public async Task ReturnsNullWhenNothingIsQueued()
    {
        var harness = Harness.Create(jobAvailable: false);

        Assert.Null(await harness.Runner.RunNextAsync(CancellationToken.None));
        Assert.Equal(0, harness.Pipeline.Calls);
    }

    [Fact]
    public async Task FailsRatherThanCrashWhenTheCompletionIsRejected()
    {
        var harness = Harness.Create();
        harness.Completion.CompleteError = ErrorCodes.StaleSource;

        // A rejected completion is logged, not thrown: the job stays leased and the
        // lease recovery path owns it from here.
        var ran = await harness.Runner.RunNextAsync(CancellationToken.None);

        Assert.Equal(harness.Job.Id, ran);
        Assert.True(harness.Completion.Completed);
    }

    private sealed class Harness
    {
        public required Job Job { get; init; }

        public required FakeQueue Queue { get; init; }

        public required FakeFiles Files { get; init; }

        public required FakePipeline Pipeline { get; init; }

        public required FakeCompletion Completion { get; init; }

        public required BackgroundRemovalJobRunner Runner { get; init; }

        public static Harness Create(
            bool designFound = true,
            bool jobAvailable = true,
            string parametersJson = "")
        {
            var job = Job.Create(
                Guid.NewGuid(),
                Guid.NewGuid(),
                Guid.NewGuid(),
                JobType.BackgroundRemoval,
                JobCapability.Cutout,
                parametersJson.Length > 0 ? parametersJson : "{}",
                $$"""{"sourceVersionId":"{{Guid.NewGuid()}}"}""",
                "batch/designs/x/versions/source.png",
                "batch/designs/x/versions/output.png",
                "{}",
                "{}",
                Job.DefaultMaxAttempts,
                DateTimeOffset.UnixEpoch).Value!;

            // Move it to running so the lease looks like a real claim.
            job.TryClaim("api-cutout", "lease-token", 900, DateTimeOffset.UnixEpoch);

            var batch = designFound ? WithDesign(job) : null;
            var files = new FakeFiles();
            var pipeline = new FakePipeline();
            var completion = new FakeCompletion();

            var queue = new FakeQueue(jobAvailable ? job : null);
            return new Harness
            {
                Job = job,
                Queue = queue,
                Files = files,
                Pipeline = pipeline,
                Completion = completion,
                Runner = new BackgroundRemovalJobRunner(
                    queue,
                    new FakeBatches(batch),
                    files,
                    pipeline,
                    completion,
                    NullLogger<BackgroundRemovalJobRunner>.Instance),
            };
        }
    }

    /// <summary>
    /// A real aggregate, not a fake: the runner only reads the current version and
    /// its path, and a hand-built batch keeps that contract honest.
    /// </summary>
    private static Batch WithDesign(Job job)
    {
        var at = DateTimeOffset.UnixEpoch;
        var geometry = BatchGeometry.Create(
            BatchGeometry.DefaultRollWidthCm,
            BatchGeometry.DefaultMarginMm,
            BatchGeometry.DefaultEdgeMarginMm,
            BatchGeometry.DefaultWorkingDpi).Value!;
        var batch = Batch.Create(job.BatchId, "Runner batch", geometry, at).Value!;
        var designId = job.DesignId!.Value;
        var original = DesignVersion.CreateOriginal(
            Guid.NewGuid(),
            designId,
            "batch/designs/x/versions/original.png",
            1000,
            1000,
            true,
            "{}",
            at).Value!;
        var design = Design.Create(
            designId,
            batch.Id,
            "Runner design",
            GarmentColor.Light,
            allowRotation: true,
            targetWidthCm: null,
            targetHeightCm: null,
            notes: null,
            original,
            BatchGeometry.DefaultWorkingDpi,
            at).Value!;
        batch.AddDesign(design, "operator", at);
        return batch;
    }

    private sealed class FakeQueue(Job? job) : IJobQueue
    {
        public IReadOnlyList<JobCapability> LastCapabilities { get; private set; } = [];

        public Task<Job?> ClaimAsync(
            string workerId,
            IReadOnlyList<JobCapability> capabilities,
            int leaseSeconds,
            bool workerJobsOnly,
            CancellationToken cancellationToken)
        {
            LastCapabilities = capabilities;
            return Task.FromResult(job);
        }
    }

    private sealed class FakeBatches(Batch? batch) : IBatchRepository
    {
        public Task<Batch?> FindAsync(Guid batchId, CancellationToken cancellationToken)
            => Task.FromResult(batch);

        public Task<Batch?> FindByDesignAsync(Guid designId, CancellationToken cancellationToken)
            => Task.FromResult(batch);

        public Task<Batch?> FindByExportAsync(Guid exportId, CancellationToken cancellationToken)
            => Task.FromResult(batch);

        public Task<(IReadOnlyList<Batch> Items, int Total)> ListAsync(
            BatchStatus? status,
            int limit,
            int offset,
            CancellationToken cancellationToken)
            => Task.FromResult<(IReadOnlyList<Batch>, int)>(([], 0));

        public Task DeleteAsync(Batch batch, CancellationToken cancellationToken)
            => Task.CompletedTask;

        public void Add(Batch aggregate) => throw new NotSupportedException();

        public Task SaveChangesAsync(CancellationToken cancellationToken)
            => Task.CompletedTask;
    }

    private sealed class FakeFiles : IFileStore
    {
        public Dictionary<string, MemoryStream> Written { get; } = [];

        public Task WriteAsync(
            string relativePath,
            Stream content,
            CancellationToken cancellationToken)
        {
            var copy = new MemoryStream();
            content.CopyTo(copy);
            Written[relativePath] = copy;
            return Task.CompletedTask;
        }

        public Task<Stream> OpenReadAsync(string relativePath, CancellationToken cancellationToken)
            => Task.FromResult<Stream>(new MemoryStream(SourcePng));

        public Task<bool> ExistsAsync(string relativePath, CancellationToken cancellationToken)
            => Task.FromResult(Written.ContainsKey(relativePath));

        public Task<long> GetLengthAsync(string relativePath, CancellationToken cancellationToken)
            => Task.FromResult(0L);

        public Task DeleteAsync(string relativePath, CancellationToken cancellationToken)
            => Task.CompletedTask;

        public Task DeleteDirectoryAsync(string relativePath, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }

    private sealed class FakePipeline : IBackgroundRemovalPipeline
    {
        public int Calls { get; private set; }

        public BackgroundRemovalException? Throws { get; set; }

        public string? LastPreferredProvider { get; private set; }

        public Task<BackgroundRemovalPipelineResult> RunAsync(
            ImageInput input,
            CancellationToken cancellationToken,
            string? preferredProvider = null)
        {
            Calls++;
            LastPreferredProvider = preferredProvider;
            if (Throws is not null)
            {
                throw Throws;
            }

            return Task.FromResult(
                new BackgroundRemovalPipelineResult(
                    ResultPng,
                    "withoutbg",
                    TimeSpan.FromSeconds(1),
                    TimeSpan.FromSeconds(2),
                    400,
                    200));
        }
    }

    private sealed class FakeCompletion : IJobCompletionPort
    {
        public bool Completed { get; private set; }

        public bool Failed { get; private set; }

        public JsonElement? Result { get; private set; }

        public JobError? Error { get; private set; }

        public string? CompleteError { get; set; }

        public Task<Domain.Common.Result> CompleteAsync(
            Guid jobId,
            string leaseToken,
            JsonElement result,
            CancellationToken cancellationToken)
        {
            Completed = true;
            Result = result;
            return Task.FromResult(
                CompleteError is null
                    ? Domain.Common.Result.Success()
                    : Domain.Common.Result.Failure(CompleteError, "rejected"));
        }

        public Task<Domain.Common.Result> FailAsync(
            Guid jobId,
            string leaseToken,
            JobError error,
            CancellationToken cancellationToken)
        {
            Failed = true;
            Error = error;
            return Task.FromResult(Domain.Common.Result.Success());
        }
    }
}
