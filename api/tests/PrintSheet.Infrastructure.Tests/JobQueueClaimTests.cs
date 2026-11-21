using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using PrintSheet.Application.Abstractions;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Jobs;
using PrintSheet.Infrastructure.Persistence;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// The claim boundary is the only thing standing between a queued cutout and a
/// worker that has no processor for it, so it is asserted against a real database
/// rather than a hand-written fake of the queue.
/// </summary>
public sealed class JobQueueClaimTests : IAsyncDisposable
{
    private readonly SqliteConnection _connection;
    private readonly PrintSheetDbContext _db;

    public JobQueueClaimTests()
    {
        // A shared in-memory database: one connection kept open for the test's
        // lifetime, so the schema survives between contexts.
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var options = new DbContextOptionsBuilder<PrintSheetDbContext>()
            .UseSqlite(_connection)
            .Options;

        _db = new PrintSheetDbContext(options);
        _db.Database.EnsureCreated();
    }

    [Fact]
    public async Task NeverLeasesAnInProcessCutoutJobToAWorker()
    {
        var batchId = Guid.NewGuid();
        var cutout = await QueueAsync(batchId, JobType.BackgroundRemoval, JobCapability.Cutout);
        await _db.SaveChangesAsync();

        var queue = new EfJobQueue(_db, new FixedClock());

        // The capabilities a real worker can request. None of them matches the
        // cutout capability, so the job stays queued for the API runner.
        var claimed = await queue.ClaimAsync(
            "worker-1",
            [JobCapability.Image, JobCapability.Gpu],
            leaseSeconds: 120,
            workerJobsOnly: false,
            CancellationToken.None);

        Assert.Null(claimed);
        var stored = await _db.Jobs.SingleAsync(job => job.Id == cutout.Id);
        Assert.Equal(JobStatus.Queued, stored.Status);
    }

    [Fact]
    public async Task StillLeasesAnImageJobToAnImageWorker()
    {
        var batchId = Guid.NewGuid();
        await QueueAsync(batchId, JobType.Trim, JobCapability.Image);
        await _db.SaveChangesAsync();

        var queue = new EfJobQueue(_db, new FixedClock());
        var claimed = await queue.ClaimAsync(
            "worker-1",
            [JobCapability.Image],
            leaseSeconds: 120,
            workerJobsOnly: false,
            CancellationToken.None);

        Assert.NotNull(claimed);
        Assert.Equal(JobType.Trim, claimed!.Type);
    }

    [Fact]
    public async Task LeasesACutoutJobToTheInProcessRunner()
    {
        var batchId = Guid.NewGuid();
        await QueueAsync(batchId, JobType.BackgroundRemoval, JobCapability.Cutout);
        await _db.SaveChangesAsync();

        var queue = new EfJobQueue(_db, new FixedClock());
        var claimed = await queue.ClaimAsync(
            "api-cutout",
            [JobCapability.Cutout],
            leaseSeconds: 900,
            workerJobsOnly: false,
            CancellationToken.None);

        Assert.NotNull(claimed);
        Assert.Equal(JobType.BackgroundRemoval, claimed!.Type);
        Assert.Equal("api-cutout", claimed.LeaseOwner);
    }

    [Fact]
    public async Task TreatsAQueuedCutoutAsAnActiveStepJob()
    {
        var batchId = Guid.NewGuid();
        await QueueAsync(batchId, JobType.BackgroundRemoval, JobCapability.Cutout);
        await _db.SaveChangesAsync();

        var jobs = new EfJobRepository(_db);

        // A cutout holds the design for up to a minute. If it did not count as an
        // active step job, a second step could be queued against the same design and
        // would fail only after the pipeline had already done all the work.
        Assert.True(await jobs.HasActiveStepJobAsync(_designId, CancellationToken.None));
    }

    [Fact]
    public async Task DoesNotTreatAFinishedCutoutAsActive()
    {
        var batchId = Guid.NewGuid();
        var job = await QueueAsync(batchId, JobType.BackgroundRemoval, JobCapability.Cutout);
        await _db.SaveChangesAsync();
        job.TryClaim("api-cutout", "lease-token", 900, DateTimeOffset.UnixEpoch);
        job.Complete("lease-token", "{}", DateTimeOffset.UnixEpoch.AddSeconds(30));
        await _db.SaveChangesAsync();

        var jobs = new EfJobRepository(_db);

        Assert.False(await jobs.HasActiveStepJobAsync(_designId, CancellationToken.None));
    }

    public async ValueTask DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    /// <summary>Every job in a test shares one design, so the active-step query is meaningful.</summary>
    private readonly Guid _designId = Guid.NewGuid();

    private async Task<Job> QueueAsync(Guid batchId, JobType type, JobCapability capability)
    {
        var job = Job.Create(
            Guid.NewGuid(),
            batchId,
            _designId,
            type,
            capability,
            "{}",
            "{}",
            "in.png",
            "out.png",
            "{}",
            "{}",
            Job.DefaultMaxAttempts,
            DateTimeOffset.UnixEpoch).Value!;

        _db.Jobs.Add(job);
        await Task.CompletedTask;
        return job;
    }

    private sealed class FixedClock : IClock
    {
        public DateTimeOffset UtcNow { get; } = DateTimeOffset.UnixEpoch.AddHours(1);
    }
}
