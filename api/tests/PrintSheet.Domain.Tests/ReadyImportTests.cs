using PrintSheet.Domain.Batches;

namespace PrintSheet.Domain.Tests;

public sealed class ReadyImportTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 8, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ImportedResize_MakesDesignReadyWithoutResampling()
    {
        var design = CreateDesign(widthPx: 2362, heightPx: 2953);

        var prepared = DesignVersion.CreateImportedResize(
            Guid.NewGuid(),
            design.Id,
            design.OriginalVersionId,
            $"{design.BatchId}/designs/{design.Id}/versions/prepared.png",
            widthPx: 2362,
            heightPx: 2953,
            hasAlpha: true,
            parametersJson: "{\"source\":\"ready-import\"}",
            Now);

        Assert.True(prepared.IsSuccess);
        var marked = design.MarkReady(prepared.Value!, Now);

        Assert.True(marked.IsSuccess);
        Assert.Equal(DesignStatus.Ready, design.Status);
        Assert.Equal(prepared.Value!.Id, design.CurrentVersionId);
        Assert.Equal(StepType.Resize, design.CurrentVersion!.StepType);
        Assert.Equal(VersionStatus.Approved, design.CurrentVersion.Status);
    }

    [Fact]
    public void ImportedResize_RejectsPixelSizeThatDoesNotMatchTarget()
    {
        var design = CreateDesign(widthPx: 2362, heightPx: 2953);

        var prepared = DesignVersion.CreateImportedResize(
            Guid.NewGuid(),
            design.Id,
            design.OriginalVersionId,
            $"{design.BatchId}/designs/{design.Id}/versions/prepared.png",
            widthPx: 2000,
            heightPx: 2500,
            hasAlpha: true,
            parametersJson: "{\"source\":\"ready-import\"}",
            Now);

        Assert.True(prepared.IsSuccess);
        var marked = design.MarkReady(prepared.Value!, Now);

        Assert.False(marked.IsSuccess);
        Assert.Equal(DesignStatus.Received, design.Status);
    }

    private static Design CreateDesign(int widthPx, int heightPx)
    {
        var batchId = Guid.NewGuid();
        var designId = Guid.NewGuid();
        var original = DesignVersion.CreateOriginal(
            Guid.NewGuid(),
            designId,
            $"{batchId}/designs/{designId}/versions/original.png",
            widthPx,
            heightPx,
            hasAlpha: true,
            parametersJson: "{\"source\":\"upload\"}",
            Now).Value!;

        var design = Design.Create(
            designId,
            batchId,
            "Ready import",
            GarmentColor.Light,
            allowRotation: true,
            targetWidthCm: 20m,
            targetHeightCm: 25m,
            notes: null,
            original,
            workingDpi: 300,
            Now).Value!;

        return design;
    }
}
