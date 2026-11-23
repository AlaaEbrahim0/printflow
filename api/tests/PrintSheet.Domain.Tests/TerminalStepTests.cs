using PrintSheet.Domain.Batches;

namespace PrintSheet.Domain.Tests;

/// <summary>
/// The shop's step order is crop → enhance → set print size → remove background,
/// so the cut-out is normally the last version. These lock in that a cut-out
/// preserving the approved print pixels is packable, while a step that changes
/// the size still is not.
/// </summary>
public sealed class TerminalStepTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 23, 12, 0, 0, TimeSpan.Zero);

    // 20 × 25 cm at 300 DPI is 2362 × 2953 px — the same numbers the ready-import
    // tests use, so the target maths stays in one place.
    private const int TargetWidthPx = 2362;
    private const int TargetHeightPx = 2953;

    [Fact]
    public void CutoutAtTheTargetPixels_MakesTheDesignReady()
    {
        var design = CreateDesign();

        ApproveResize(design, TargetWidthPx, TargetHeightPx);
        Assert.Equal(DesignStatus.Ready, design.Status);

        var cutout = ApproveCutout(design, TargetWidthPx, TargetHeightPx);

        Assert.True(cutout, "the cut-out proposal should have been accepted");
        Assert.Equal(DesignStatus.Ready, design.Status);
        Assert.Equal(StepType.BackgroundRemoval, design.CurrentVersion!.StepType);
    }

    [Fact]
    public void CutoutThatChangesTheSize_LeavesTheDesignInProgress()
    {
        var design = CreateDesign();
        ApproveResize(design, TargetWidthPx, TargetHeightPx);

        // A cut-out that resampled the artwork no longer matches the target, so
        // it must not be reported as ready — the packer would reject it.
        ApproveCutout(design, TargetWidthPx + 10, TargetHeightPx);

        Assert.Equal(DesignStatus.InProgress, design.Status);
    }

    [Fact]
    public void CutoutWithNoTargetSet_IsNotReady()
    {
        var design = CreateDesign(targetWidthCm: null, targetHeightCm: null);
        ApproveCutout(design, TargetWidthPx, TargetHeightPx);

        Assert.NotEqual(DesignStatus.Ready, design.Status);
    }

    [Fact]
    public void UpscaleAtTheTargetPixels_IsStillNotTerminal()
    {
        // An upscale happens before print size is set; even at matching pixels it
        // is not the step that establishes the printed size.
        var design = CreateDesign();
        var upscaled = DesignVersion.CreateProposal(
            Guid.NewGuid(),
            design.Id,
            design.OriginalVersionId,
            StepType.Upscale,
            $"{design.BatchId}/designs/{design.Id}/versions/up.png",
            maskPath: null,
            svgPath: null,
            widthPx: TargetWidthPx,
            heightPx: TargetHeightPx,
            hasAlpha: true,
            parametersJson: "{}",
            jobId: Guid.NewGuid(),
            Now);

        Assert.True(design.AddProposal(upscaled.Value!, Now).IsSuccess);
        Assert.True(design.ApproveVersion(upscaled.Value!.Id, Now).IsSuccess);

        Assert.NotEqual(DesignStatus.Ready, design.Status);
    }

    private static Design CreateDesign(decimal? targetWidthCm = 20m, decimal? targetHeightCm = 25m)
    {
        var batchId = Guid.NewGuid();
        var designId = Guid.NewGuid();
        var original = DesignVersion.CreateOriginal(
            Guid.NewGuid(),
            designId,
            $"{batchId}/designs/{designId}/versions/original.png",
            widthPx: 1000,
            heightPx: 1250,
            hasAlpha: true,
            parametersJson: "{\"source\":\"upload\"}",
            Now).Value!;

        return Design.Create(
            designId,
            batchId,
            "Terminal step",
            GarmentColor.Light,
            allowRotation: true,
            targetWidthCm,
            targetHeightCm,
            notes: null,
            original,
            workingDpi: 300,
            Now).Value!;
    }

    private static void ApproveResize(Design design, int widthPx, int heightPx)
    {
        var resize = DesignVersion.CreateProposal(
            Guid.NewGuid(),
            design.Id,
            design.OriginalVersionId,
            StepType.Resize,
            $"{design.BatchId}/designs/{design.Id}/versions/resize.png",
            maskPath: null,
            svgPath: null,
            widthPx,
            heightPx,
            hasAlpha: true,
            parametersJson: "{}",
            jobId: Guid.NewGuid(),
            Now).Value!;

        Assert.True(design.AddProposal(resize, Now).IsSuccess);
        Assert.True(design.ApproveVersion(resize.Id, Now).IsSuccess);
    }

    private static bool ApproveCutout(Design design, int widthPx, int heightPx)
    {
        var cutout = DesignVersion.CreateProposal(
            Guid.NewGuid(),
            design.Id,
            design.CurrentVersionId,
            StepType.BackgroundRemoval,
            $"{design.BatchId}/designs/{design.Id}/versions/cutout.png",
            maskPath: null,
            svgPath: null,
            widthPx,
            heightPx,
            hasAlpha: true,
            parametersJson: "{}",
            jobId: Guid.NewGuid(),
            Now);

        if (!cutout.IsSuccess)
        {
            return false;
        }

        if (!design.AddProposal(cutout.Value!, Now).IsSuccess)
        {
            return false;
        }

        return design.ApproveVersion(cutout.Value!.Id, Now).IsSuccess;
    }
}
