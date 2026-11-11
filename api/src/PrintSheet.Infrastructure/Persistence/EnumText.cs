using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using PrintSheet.Domain.Batches;

namespace PrintSheet.Infrastructure.Persistence;

/// <summary>
/// Contract-string enum conversions. Storing the names keeps the database
/// readable and stable if enum ordinals ever change; every parser rejects
/// unknown values instead of silently defaulting.
/// </summary>
public static class EnumText
{
    public static readonly ValueConverter<BatchStatus, string> BatchStatusConverter = new(
        value => value.ToContract(),
        text => ParseBatchStatus(text));

    public static readonly ValueConverter<DesignStatus, string> DesignStatusConverter = new(
        value => value.ToContract(),
        text => ParseDesignStatus(text));

    public static readonly ValueConverter<VersionStatus, string> VersionStatusConverter = new(
        value => value.ToContract(),
        text => ParseVersionStatus(text));

    public static readonly ValueConverter<StepType, string> StepTypeConverter = new(
        value => value.ToContract(),
        text => ParseStepType(text));

    public static readonly ValueConverter<SheetState, string> SheetStateConverter = new(
        value => value.ToContract(),
        text => ParseSheetState(text));

    public static readonly ValueConverter<ExportFormat, string> ExportFormatConverter = new(
        value => value.ToContract(),
        text => ParseExportFormat(text));

    public static readonly ValueConverter<ExportStatus, string> ExportStatusConverter = new(
        value => value.ToContract(),
        text => ParseExportStatus(text));

    public static readonly ValueConverter<ExportArtifactName, string> ExportArtifactNameConverter = new(
        value => value.ToContract(),
        text => ParseExportArtifactName(text));

    public static readonly ValueConverter<GarmentColorKind, string> GarmentColorKindConverter = new(
        value => value.ToContract(),
        text => ParseGarmentColorKind(text));

    public static readonly ValueConverter<JobStatus, string> JobStatusConverter = new(
        value => value.ToContract(),
        text => ParseJobStatus(text));

    public static readonly ValueConverter<JobType, string> JobTypeConverter = new(
        value => value.ToContract(),
        text => ParseJobType(text));

    public static readonly ValueConverter<JobCapability, string> JobCapabilityConverter = new(
        value => value.ToContract(),
        text => ParseJobCapability(text));

    private static BatchStatus ParseBatchStatus(string text) => text switch
    {
        "collecting" => BatchStatus.Collecting,
        "ready-to-pack" => BatchStatus.ReadyToPack,
        "packed" => BatchStatus.Packed,
        "exported" => BatchStatus.Exported,
        _ => throw new InvalidOperationException($"Unknown batch status '{text}'."),
    };

    private static DesignStatus ParseDesignStatus(string text) => text switch
    {
        "received" => DesignStatus.Received,
        "in-progress" => DesignStatus.InProgress,
        "ready" => DesignStatus.Ready,
        "needs-better-source" => DesignStatus.NeedsBetterSource,
        "excluded" => DesignStatus.Excluded,
        _ => throw new InvalidOperationException($"Unknown design status '{text}'."),
    };

    private static VersionStatus ParseVersionStatus(string text) => text switch
    {
        "proposed" => VersionStatus.Proposed,
        "approved" => VersionStatus.Approved,
        "rejected" => VersionStatus.Rejected,
        _ => throw new InvalidOperationException($"Unknown version status '{text}'."),
    };

    private static StepType ParseStepType(string text) => text switch
    {
        "original" => StepType.Original,
        "trim" => StepType.Trim,
        "crop" => StepType.Crop,
        "upscale" => StepType.Upscale,
        "vectorize" => StepType.Vectorize,
        "background-removal" => StepType.BackgroundRemoval,
        "manual-edit" => StepType.ManualEdit,
        "resize" => StepType.Resize,
        _ => throw new InvalidOperationException($"Unknown step type '{text}'."),
    };

    private static SheetState ParseSheetState(string text) => text switch
    {
        "unchecked" => SheetState.Unchecked,
        "valid" => SheetState.Valid,
        "invalid" => SheetState.Invalid,
        _ => throw new InvalidOperationException($"Unknown sheet state '{text}'."),
    };

    private static ExportFormat ParseExportFormat(string text) => text switch
    {
        "flat-png" => ExportFormat.FlatPng,
        "flat-tiff" => ExportFormat.FlatTiff,
        "layered-psd" => ExportFormat.LayeredPsd,
        "layered-psb" => ExportFormat.LayeredPsb,
        "psd-bundle" => ExportFormat.PsdBundle,
        _ => throw new InvalidOperationException($"Unknown export format '{text}'."),
    };

    private static ExportStatus ParseExportStatus(string text) => text switch
    {
        "queued" => ExportStatus.Queued,
        "running" => ExportStatus.Running,
        "succeeded" => ExportStatus.Succeeded,
        "failed" => ExportStatus.Failed,
        "blocked" => ExportStatus.Blocked,
        _ => throw new InvalidOperationException($"Unknown export status '{text}'."),
    };

    private static ExportArtifactName ParseExportArtifactName(string text)
        => ExportArtifactNameExtensions.TryParseContract(text, out var parsed)
            ? parsed
            : throw new InvalidOperationException($"Unknown export artifact '{text}'.");

    private static GarmentColorKind ParseGarmentColorKind(string text) => text switch
    {
        "light" => GarmentColorKind.Light,
        "dark" => GarmentColorKind.Dark,
        "custom" => GarmentColorKind.Custom,
        _ => throw new InvalidOperationException($"Unknown garment colour kind '{text}'."),
    };

    private static JobStatus ParseJobStatus(string text) => text switch
    {
        "queued" => JobStatus.Queued,
        "running" => JobStatus.Running,
        "succeeded" => JobStatus.Succeeded,
        "failed" => JobStatus.Failed,
        "cancelled" => JobStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown job status '{text}'."),
    };

    private static JobType ParseJobType(string text) => text switch
    {
        "classify" => JobType.Classify,
        "trim" => JobType.Trim,
        "background-removal" => JobType.BackgroundRemoval,
        "upscale" => JobType.Upscale,
        "vectorize" => JobType.Vectorize,
        "resize" => JobType.Resize,
        "pack-sheet" => JobType.PackSheet,
        "integrity-check" => JobType.IntegrityCheck,
        "export" => JobType.Export,
        _ => throw new InvalidOperationException($"Unknown job type '{text}'."),
    };

    private static JobCapability ParseJobCapability(string text) => text switch
    {
        "image" => JobCapability.Image,
        "gpu" => JobCapability.Gpu,
        "packer" => JobCapability.Packer,
        "export" => JobCapability.Export,
        _ => throw new InvalidOperationException($"Unknown job capability '{text}'."),
    };
}
