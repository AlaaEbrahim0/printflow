namespace PrintSheet.Domain.Batches;

public enum BatchStatus
{
    Collecting,
    ReadyToPack,
    Packed,
    Exported,
}

public enum DesignStatus
{
    Received,
    InProgress,
    Ready,
    NeedsBetterSource,
    Excluded,
}

public enum VersionStatus
{
    Proposed,
    Approved,
    Rejected,
}

public enum StepType
{
    Original,
    Trim,
    Crop,
    Upscale,
    Vectorize,
    BackgroundRemoval,
    ManualEdit,
    Resize,
}

public enum SheetState
{
    Unchecked,
    Valid,
    Invalid,
}

public enum ExportFormat
{
    FlatPng,
    FlatTiff,
    LayeredPsd,
    LayeredPsb,
    PsdBundle,
}

public enum ExportStatus
{
    Queued,
    Running,
    Succeeded,
    Failed,
    Blocked,
}

public enum JobStatus
{
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

public enum JobType
{
    Classify,
    Trim,
    BackgroundRemoval,
    Upscale,
    Vectorize,
    Resize,
    PackSheet,
    IntegrityCheck,
    Export,
}

public enum JobCapability
{
    Image,
    Gpu,
    Packer,
    Export,
}

public enum GarmentColorKind
{
    Light,
    Dark,
    Custom,
}

public static class BatchEnumNames
{
    public static string ToContract(this BatchStatus value) => value switch
    {
        BatchStatus.Collecting => "collecting",
        BatchStatus.ReadyToPack => "ready-to-pack",
        BatchStatus.Packed => "packed",
        BatchStatus.Exported => "exported",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this DesignStatus value) => value switch
    {
        DesignStatus.Received => "received",
        DesignStatus.InProgress => "in-progress",
        DesignStatus.Ready => "ready",
        DesignStatus.NeedsBetterSource => "needs-better-source",
        DesignStatus.Excluded => "excluded",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this VersionStatus value) => value switch
    {
        VersionStatus.Proposed => "proposed",
        VersionStatus.Approved => "approved",
        VersionStatus.Rejected => "rejected",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this StepType value) => value switch
    {
        StepType.Original => "original",
        StepType.Trim => "trim",
        StepType.Crop => "crop",
        StepType.Upscale => "upscale",
        StepType.Vectorize => "vectorize",
        StepType.BackgroundRemoval => "background-removal",
        StepType.ManualEdit => "manual-edit",
        StepType.Resize => "resize",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this SheetState value) => value switch
    {
        SheetState.Unchecked => "unchecked",
        SheetState.Valid => "valid",
        SheetState.Invalid => "invalid",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this ExportFormat value) => value switch
    {
        ExportFormat.FlatPng => "flat-png",
        ExportFormat.FlatTiff => "flat-tiff",
        ExportFormat.LayeredPsd => "layered-psd",
        ExportFormat.LayeredPsb => "layered-psb",
        ExportFormat.PsdBundle => "psd-bundle",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this ExportStatus value) => value switch
    {
        ExportStatus.Queued => "queued",
        ExportStatus.Running => "running",
        ExportStatus.Succeeded => "succeeded",
        ExportStatus.Failed => "failed",
        ExportStatus.Blocked => "blocked",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this JobStatus value) => value switch
    {
        JobStatus.Queued => "queued",
        JobStatus.Running => "running",
        JobStatus.Succeeded => "succeeded",
        JobStatus.Failed => "failed",
        JobStatus.Cancelled => "cancelled",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this JobType value) => value switch
    {
        JobType.Classify => "classify",
        JobType.Trim => "trim",
        JobType.BackgroundRemoval => "background-removal",
        JobType.Upscale => "upscale",
        JobType.Vectorize => "vectorize",
        JobType.Resize => "resize",
        JobType.PackSheet => "pack-sheet",
        JobType.IntegrityCheck => "integrity-check",
        JobType.Export => "export",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this JobCapability value) => value switch
    {
        JobCapability.Image => "image",
        JobCapability.Gpu => "gpu",
        JobCapability.Packer => "packer",
        JobCapability.Export => "export",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static string ToContract(this GarmentColorKind value) => value switch
    {
        GarmentColorKind.Light => "light",
        GarmentColorKind.Dark => "dark",
        GarmentColorKind.Custom => "custom",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };
}

public enum ExportArtifactName
{
    Flat,
    Layered,
    Preview,
    Manifest,
    Jsx,
}

public static class ExportArtifactNameExtensions
{
    public static string ToContract(this ExportArtifactName value) => value switch
    {
        ExportArtifactName.Flat => "flat",
        ExportArtifactName.Layered => "layered",
        ExportArtifactName.Preview => "preview",
        ExportArtifactName.Manifest => "manifest",
        ExportArtifactName.Jsx => "jsx",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static bool TryParseContract(string? value, out ExportArtifactName artifact)
    {
        artifact = value switch
        {
            "flat" => ExportArtifactName.Flat,
            "layered" => ExportArtifactName.Layered,
            "preview" => ExportArtifactName.Preview,
            "manifest" => ExportArtifactName.Manifest,
            "jsx" => ExportArtifactName.Jsx,
            _ => (ExportArtifactName)(-1),
        };
        return Enum.IsDefined(artifact);
    }
}
