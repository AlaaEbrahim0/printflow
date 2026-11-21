using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Services;
using PrintSheet.Application.Settings;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;
using PrintSheet.Infrastructure.Imaging;
using PrintSheet.Infrastructure.Persistence;
using PrintSheet.Infrastructure.Storage;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// The completion handshake is the only way a cutout becomes a version, and it
/// dispatches on job type. These tests exist because two live-only defects hid
/// here: an in-process cutout was rejected as "Unsupported job type" and, once
/// that was fixed, would have been recorded as a `trim` version because the step
/// type fell through to the default arm.
/// </summary>
public sealed class JobCompletionCutoutTests : IAsyncDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "printsheet-cutout-tests",
        Guid.NewGuid().ToString("N"));

    private readonly SqliteConnectionFixture _db = new();

    [Fact]
    public async Task AppliesACutoutAsABackgroundRemovalVersion()
    {
        var (designId, parentId, outputPath) = await SeedAsync();
        await WritePngAsync(outputPath, 120, 80);

        var completion = CreateCompletion();
        var result = await completion.CompleteAsync(
            _jobId,
            LeaseToken,
            BuildResult(outputPath, 120, 80),
            CancellationToken.None);

        Assert.True(result.IsSuccess, result.Error?.Message);

        // Read back through the aggregate: versions are owned by the design.
        _db.Db.ChangeTracker.Clear();
        var batch = await _db.Db.Batches
            .Include(entity => entity.Designs)
            .ThenInclude(design => design.Versions)
            .SingleAsync(entity => entity.Designs.Any(design => design.Id == designId));
        var stored = batch.FindDesign(designId)!
            .Versions
            .Single(version => version.ParentId == parentId);

        Assert.Equal(StepType.BackgroundRemoval, stored.StepType);
        Assert.Equal(VersionStatus.Proposed, stored.Status);
        Assert.Equal(outputPath, stored.FilePath);
    }

    [Fact]
    public async Task FailsWhenTheDeclaredSizeDoesNotMatchTheFile()
    {
        var (_, _, outputPath) = await SeedAsync();
        await WritePngAsync(outputPath, 120, 80);

        // Declaring 999 px while the file is 120 px must be refused, not versioned.
        // A rejected apply is recorded as a job failure (the handshake still
        // succeeds), so the assertion is on the job and the absence of a version.
        var result = await CreateCompletion().CompleteAsync(
            _jobId,
            LeaseToken,
            BuildResult(outputPath, 999, 80),
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        _db.Db.ChangeTracker.Clear();
        var job = await _db.Db.Jobs.SingleAsync(entity => entity.Id == _jobId);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Contains("999", job.ErrorJson);

        var versions = await _db.Db.Batches
            .SelectMany(batch => batch.Designs)
            .SelectMany(design => design.Versions)
            .CountAsync();
        Assert.Equal(1, versions);
    }

    public async ValueTask DisposeAsync()
    {
        await _db.DisposeAsync();
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private const string LeaseToken = "lease-token";
    private readonly Guid _jobId = Guid.NewGuid();

    private JobCompletionService CreateCompletion()
    {
        var files = new LocalFileStore(new StorageOptions { Root = _root });
        return new JobCompletionService(
            new EfBatchRepository(_db.Db),
            new EfJobRepository(_db.Db),
            files,
            new SkiaImageInspector(),
            new EfAppSettingsStore(_db.Db, new FixedClock()),
            new FixedClock());
    }

    private async Task<(Guid DesignId, Guid ParentId, string OutputPath)> SeedAsync()
    {
        var at = DateTimeOffset.UnixEpoch;
        var geometry = BatchGeometry.Create(
            BatchGeometry.DefaultRollWidthCm,
            BatchGeometry.DefaultMarginMm,
            BatchGeometry.DefaultEdgeMarginMm,
            BatchGeometry.DefaultWorkingDpi).Value!;
        var batch = Batch.Create(Guid.NewGuid(), "Cutout batch", geometry, at).Value!;

        var designId = Guid.NewGuid();
        var parentId = Guid.NewGuid();
        var parentPath = $"{(batch.Id)}/designs/{designId}/versions/{parentId}.png";
        await WritePngAsync(parentPath, 600, 400);

        var original = DesignVersion.CreateOriginal(
            parentId,
            designId,
            parentPath,
            600,
            400,
            true,
            "{}",
            at).Value!;
        var design = Design.Create(
            designId,
            batch.Id,
            "Cutout design",
            GarmentColor.Light,
            allowRotation: true,
            targetWidthCm: null,
            targetHeightCm: null,
            notes: null,
            original,
            BatchGeometry.DefaultWorkingDpi,
            at).Value!;
        batch.AddDesign(design, "operator", at);

        var outputPath = $"{(batch.Id)}/designs/{designId}/versions/{_jobId}.png";
        var job = Job.Create(
            _jobId,
            batch.Id,
            designId,
            JobType.BackgroundRemoval,
            JobCapability.Cutout,
            "{}",
            JsonSerializer.Serialize(new { sourceVersionId = parentId }),
            parentPath,
            outputPath,
            "{}",
            "{}",
            Job.DefaultMaxAttempts,
            at).Value!;
        // Claim at the same instant the completion service will report, so the
        // lease is live rather than already expired.
        job.TryClaim("api-cutout", LeaseToken, 900, new FixedClock().UtcNow);

        _db.Db.Batches.Add(batch);
        _db.Db.Jobs.Add(job);
        await _db.Db.SaveChangesAsync();

        return (designId, parentId, outputPath);
    }

    private JsonElement BuildResult(string outputPath, int widthPx, int heightPx)
    {
        var json = JsonSerializer.Serialize(new
        {
            schemaVersion = "1.0",
            jobId = _jobId,
            status = "succeeded",
            outputPath,
            outputArtifacts = new { },
            metadata = new { widthPx, heightPx, hasAlpha = true },
        });

        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private async Task WritePngAsync(string relativePath, int width, int height)
    {
        using var bitmap = new SKBitmap(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(new SKColor(200, 30, 30, 255));
        }

        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        var files = new LocalFileStore(new StorageOptions { Root = _root });
        await files.WriteAsync(relativePath, data.AsStream(), CancellationToken.None);
    }

    private sealed class FixedClock : IClock
    {
        public DateTimeOffset UtcNow { get; } = DateTimeOffset.UnixEpoch.AddHours(1);
    }
}

/// <summary>A shared in-memory SQLite database with the schema created.</summary>
internal sealed class SqliteConnectionFixture : IAsyncDisposable
{
    private readonly Microsoft.Data.Sqlite.SqliteConnection _connection;

    public SqliteConnectionFixture()
    {
        _connection = new Microsoft.Data.Sqlite.SqliteConnection("DataSource=:memory:");
        _connection.Open();
        Db = new PrintSheetDbContext(
            new DbContextOptionsBuilder<PrintSheetDbContext>().UseSqlite(_connection).Options);
        Db.Database.EnsureCreated();
    }

    public PrintSheetDbContext Db { get; }

    public async ValueTask DisposeAsync()
    {
        await Db.DisposeAsync();
        await _connection.DisposeAsync();
    }
}
