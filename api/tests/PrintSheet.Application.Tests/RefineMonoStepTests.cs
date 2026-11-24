using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Application.Batches;
using PrintSheet.Application.Mono;
using PrintSheet.Application.Services;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Application.Tests;

/// <summary>
/// The mono refinement is a finishing pass, so the API has to refuse it before the
/// print size is established. These assert that boundary rather than the worker's
/// behaviour: the classifier and the chain are tested in the worker's own suite.
/// </summary>
public sealed class RefineMonoStepTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 23, 12, 0, 0, TimeSpan.Zero);

    // 20 × 25 cm at 300 DPI.
    private const int TargetWidthPx = 2362;
    private const int TargetHeightPx = 2953;

    [Fact]
    public async Task QueuesAtThePrintSizeWithThePresetAsAJobParameter()
    {
        var (service, jobs, design) = Create(sized: true);

        var accepted = await service.ProposeRefineMonoAsync(
            design.Id,
            new RefineMonoStepCommand(MonoPresets.Logo, false, null, null, null, null),
            CancellationToken.None);

        Assert.True(accepted.IsSuccess, accepted.Error?.Message);
        var job = Assert.Single(jobs.Added);
        Assert.Equal(JobType.RefineMono, job.Type);
        Assert.Equal(JobCapability.Image, job.Capability);
        Assert.Contains("\"preset\":\"logo\"", job.ParametersJson);
        // Consent is only recorded when the operator gave it, so a stored job
        // cannot be misread as "this logo was knowingly flattened".
        Assert.DoesNotContain("binarizeFlatColour", job.ParametersJson);
    }

    [Fact]
    public async Task RecordsFlatColourConsentWhenTheOperatorGaveIt()
    {
        var (service, jobs, design) = Create(sized: true);

        var accepted = await service.ProposeRefineMonoAsync(
            design.Id,
            new RefineMonoStepCommand(MonoPresets.Illustration, true, null, null, null, null),
            CancellationToken.None);

        Assert.True(accepted.IsSuccess, accepted.Error?.Message);
        Assert.Contains("\"binarizeFlatColour\":true", Assert.Single(jobs.Added).ParametersJson);
    }

    [Fact]
    public async Task RefusesARefinementBeforeThePrintSizeIsSet()
    {
        // The cut has to be made at the final print pixels: a resize afterwards
        // would resample the hard plate back into greys and waste the job.
        var (service, jobs, design) = Create(sized: false);

        var refused = await service.ProposeRefineMonoAsync(
            design.Id,
            new RefineMonoStepCommand(MonoPresets.Text, false, null, null, null, null),
            CancellationToken.None);

        Assert.False(refused.IsSuccess);
        Assert.Equal(ErrorCodes.InvalidTargetSize, refused.Error!.Code);
        Assert.Contains("print size", refused.Error.Message);
        Assert.Empty(jobs.Added);
    }

    [Fact]
    public async Task RefusesAnUnknownPresetWithoutQueueingAnything()
    {
        var (service, jobs, design) = Create(sized: true);

        var refused = await service.ProposeRefineMonoAsync(
            design.Id,
            new RefineMonoStepCommand("posterize", false, null, null, null, null),
            CancellationToken.None);

        Assert.False(refused.IsSuccess);
        Assert.Equal(ErrorCodes.InvalidRequest, refused.Error!.Code);
        Assert.Contains("posterize", refused.Error.Message);
        Assert.Empty(jobs.Added);
    }

    [Fact]
    public async Task RefusesAnUnknownThresholdMode()
    {
        var (service, jobs, design) = Create(sized: true);

        var refused = await service.ProposeRefineMonoAsync(
            design.Id,
            new RefineMonoStepCommand(MonoPresets.Text, false, "sauvola", null, null, null),
            CancellationToken.None);

        Assert.False(refused.IsSuccess);
        Assert.Equal(ErrorCodes.InvalidRequest, refused.Error!.Code);
        Assert.Empty(jobs.Added);
    }

    [Fact]
    public async Task RefusesCleanOnlyWithBinarizeConsent()
    {
        // The two instructions contradict: clean-only is defined by keeping the
        // colours. Silently honouring either would discard what the operator
        // explicitly asked for, so the request is refused instead.
        var (service, jobs, design) = Create(sized: true);

        var refused = await service.ProposeRefineMonoAsync(
            design.Id,
            new RefineMonoStepCommand(MonoPresets.CleanOnly, true, null, null, null, null),
            CancellationToken.None);

        Assert.False(refused.IsSuccess);
        Assert.Equal(ErrorCodes.InvalidRequest, refused.Error!.Code);
        Assert.Contains("clean-only", refused.Error.Message);
        Assert.Empty(jobs.Added);
    }

    [Fact]
    public async Task AcceptsAPresetInAnyCase()
    {
        var (service, _, design) = Create(sized: true);

        var accepted = await service.ProposeRefineMonoAsync(
            design.Id,
            new RefineMonoStepCommand("TEXT", false, null, null, null, null),
            CancellationToken.None);

        Assert.True(accepted.IsSuccess, accepted.Error?.Message);
    }

    /// <summary>
    /// A real aggregate: the service reads the design's status, pending proposal
    /// and current version, so a hand-built one keeps those rules honest.
    /// </summary>
    private static (StepService Service, RecordingJobs Jobs, Design Design) Create(bool sized)
    {
        var geometry = BatchGeometry.Create(
            BatchGeometry.DefaultRollWidthCm,
            BatchGeometry.DefaultMarginMm,
            BatchGeometry.DefaultEdgeMarginMm,
            BatchGeometry.DefaultWorkingDpi).Value!;
        var batch = Batch.Create(Guid.NewGuid(), "Mono batch", geometry, Now).Value!;
        var designId = Guid.NewGuid();

        var original = DesignVersion.CreateOriginal(
            Guid.NewGuid(),
            designId,
            $"{batch.Id}/designs/{designId}/versions/original.png",
            widthPx: 1000,
            heightPx: 1250,
            hasAlpha: true,
            parametersJson: "{}",
            Now).Value!;

        var design = Design.Create(
            designId,
            batch.Id,
            "Mono design",
            GarmentColor.Light,
            allowRotation: true,
            targetWidthCm: 20m,
            targetHeightCm: 25m,
            notes: null,
            original,
            workingDpi: 300,
            Now).Value!;
        batch.AddDesign(design, "operator", Now);

        if (sized)
        {
            var resize = DesignVersion.CreateProposal(
                Guid.NewGuid(),
                design.Id,
                design.OriginalVersionId,
                StepType.Resize,
                $"{batch.Id}/designs/{designId}/versions/resize.png",
                maskPath: null,
                svgPath: null,
                widthPx: TargetWidthPx,
                heightPx: TargetHeightPx,
                hasAlpha: true,
                parametersJson: "{}",
                jobId: Guid.NewGuid(),
                Now).Value!;
            Assert.True(design.AddProposal(resize, Now).IsSuccess);
            Assert.True(design.ApproveVersion(resize.Id, Now).IsSuccess);
        }

        var jobs = new RecordingJobs();
        var service = new StepService(
            new SingleBatch(batch),
            jobs,
            new FixedClock(),
            Options.Create(new BackgroundRemovalOptions()));
        return (service, jobs, design);
    }

    private sealed class SingleBatch(Batch batch) : IBatchRepository
    {
        public Task<Batch?> FindAsync(Guid batchId, CancellationToken cancellationToken)
            => Task.FromResult<Batch?>(batch.Id == batchId ? batch : null);

        public Task<Batch?> FindByDesignAsync(Guid designId, CancellationToken cancellationToken)
            => Task.FromResult(batch.FindDesign(designId) is null ? null : batch);

        public Task<Batch?> FindByExportAsync(Guid exportId, CancellationToken cancellationToken)
            => Task.FromResult<Batch?>(null);

        public Task<(IReadOnlyList<Batch> Items, int Total)> ListAsync(
            BatchStatus? status,
            int limit,
            int offset,
            CancellationToken cancellationToken)
            => Task.FromResult<(IReadOnlyList<Batch>, int)>(([], 0));

        public Task DeleteAsync(Batch aggregate, CancellationToken cancellationToken)
            => Task.CompletedTask;

        public void Add(Batch aggregate) => throw new NotSupportedException();

        public Task SaveChangesAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class RecordingJobs : IJobRepository
    {
        public List<Job> Added { get; } = [];

        public Task<Job?> FindAsync(Guid jobId, CancellationToken cancellationToken)
            => Task.FromResult(Added.FirstOrDefault(job => job.Id == jobId));

        public Task<(IReadOnlyList<Job> Items, int Total)> ListByBatchAsync(
            Guid batchId,
            JobStatus? status,
            JobType? type,
            int limit,
            CancellationToken cancellationToken)
            => Task.FromResult<(IReadOnlyList<Job>, int)>(([], 0));

        public Task<(IReadOnlyList<Job> Items, int Total)> ListAllAsync(
            JobStatus? status,
            JobType? type,
            int limit,
            CancellationToken cancellationToken)
            => Task.FromResult<(IReadOnlyList<Job>, int)>(([], 0));

        public Task<bool> HasActiveJobAsync(
            Guid batchId,
            JobType type,
            Guid? designId,
            CancellationToken cancellationToken)
            => Task.FromResult(false);

        public Task<bool> HasActiveStepJobAsync(Guid designId, CancellationToken cancellationToken)
            => Task.FromResult(false);

        public Task<bool> HasAnyActiveJobAsync(Guid batchId, CancellationToken cancellationToken)
            => Task.FromResult(false);

        public Task DeleteByBatchAsync(Guid batchId, CancellationToken cancellationToken)
            => Task.CompletedTask;

        public void Add(Job job) => Added.Add(job);

        public Task SaveChangesAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class FixedClock : IClock
    {
        public DateTimeOffset UtcNow => Now;
    }
}
