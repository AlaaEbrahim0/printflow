using PrintSheet.Api.Contracts;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Api;

/// <summary>Domain failures become ProblemDetails with a stable machine code.</summary>
public static class ApiResults
{
    public static IResult Problem(DomainError error)
        => Problem(error.Code, error.Message, StatusFor(error.Code), error.Details);

    public static IResult Problem(string code, string message, int status = 422)
        => Problem(code, message, status, null);

    public static IResult Problem(
        string code,
        string message,
        int status,
        IReadOnlyDictionary<string, object?>? details)
        => Results.Json(
            new ProblemDetailsDto(
                Title: TitleFor(status),
                Status: status,
                Detail: message,
                Instance: null,
                Code: code,
                Errors: details),
            statusCode: status,
            contentType: "application/problem+json");

    private static string TitleFor(int status) => status switch
    {
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        _ => "Error",
    };

    public static int StatusFor(string code) => code switch
    {
        ErrorCodes.BatchNotFound => 404,
        ErrorCodes.DesignNotFound => 404,
        ErrorCodes.VersionNotFound => 404,
        ErrorCodes.JobNotFound => 404,
        ErrorCodes.ExportNotFound => 404,
        ErrorCodes.SheetNotFound => 404,
        ErrorCodes.WorkerKeyInvalid => 401,
        ErrorCodes.UploadTooLarge => 413,
        ErrorCodes.ProposalInFlight => 409,
        ErrorCodes.JobInFlight => 409,
        ErrorCodes.StaleProposal => 409,
        ErrorCodes.InvalidTransition => 409,
        ErrorCodes.VersionNotApproved => 409,
        ErrorCodes.DesignNotReady => 409,
        ErrorCodes.DesignExceedsRoll => 409,
        ErrorCodes.BatchNotReady => 409,
        ErrorCodes.BatchHasNoDesigns => 409,
        ErrorCodes.SheetStale => 409,
        ErrorCodes.SheetIntegrityFailed => 409,
        ErrorCodes.StaleRevision => 409,
        ErrorCodes.StaleSource => 409,
        ErrorCodes.JobNotCancellable => 409,
        ErrorCodes.LeaseInvalid => 409,
        ErrorCodes.ConcurrencyConflict => 409,
        ErrorCodes.ExportFormatUnavailable => 422,
        ErrorCodes.InvalidTargetSize => 422,
        ErrorCodes.InvalidRequest => 422,
        ErrorCodes.UnsupportedImage => 422,
        _ => 422,
    };

    public static bool TryParseBatchStatus(string? value, out BatchStatus status)
        => TryParse(value, new Dictionary<string, BatchStatus>(StringComparer.OrdinalIgnoreCase)
        {
            ["collecting"] = BatchStatus.Collecting,
            ["ready-to-pack"] = BatchStatus.ReadyToPack,
            ["packed"] = BatchStatus.Packed,
            ["exported"] = BatchStatus.Exported,
        }, out status);

    public static bool TryParseJobStatus(string? value, out JobStatus status)
        => TryParse(value, new Dictionary<string, JobStatus>(StringComparer.OrdinalIgnoreCase)
        {
            ["queued"] = JobStatus.Queued,
            ["running"] = JobStatus.Running,
            ["succeeded"] = JobStatus.Succeeded,
            ["failed"] = JobStatus.Failed,
            ["cancelled"] = JobStatus.Cancelled,
        }, out status);

    public static bool TryParseJobType(string? value, out JobType type)
        => TryParse(value, new Dictionary<string, JobType>(StringComparer.OrdinalIgnoreCase)
        {
            ["classify"] = JobType.Classify,
            ["trim"] = JobType.Trim,
            ["background-removal"] = JobType.BackgroundRemoval,
            ["upscale"] = JobType.Upscale,
            ["vectorize"] = JobType.Vectorize,
            ["resize"] = JobType.Resize,
            ["pack-sheet"] = JobType.PackSheet,
            ["integrity-check"] = JobType.IntegrityCheck,
            ["export"] = JobType.Export,
        }, out type);

    public static bool TryParseGarmentColorKind(string? value, out GarmentColorKind kind)
        => TryParse(value, new Dictionary<string, GarmentColorKind>(StringComparer.OrdinalIgnoreCase)
        {
            ["light"] = GarmentColorKind.Light,
            ["dark"] = GarmentColorKind.Dark,
            ["custom"] = GarmentColorKind.Custom,
        }, out kind);

    public static bool TryParseExportFormat(string? value, out ExportFormat format)
        => TryParse(value, new Dictionary<string, ExportFormat>(StringComparer.OrdinalIgnoreCase)
        {
            ["flat-png"] = ExportFormat.FlatPng,
            ["flat-tiff"] = ExportFormat.FlatTiff,
            ["layered-psd"] = ExportFormat.LayeredPsd,
            ["layered-psb"] = ExportFormat.LayeredPsb,
            ["psd-bundle"] = ExportFormat.PsdBundle,
        }, out format);

    private static bool TryParse<T>(string? value, IReadOnlyDictionary<string, T> values, out T result)
    {
        if (value is not null && values.TryGetValue(value, out var parsed))
        {
            result = parsed;
            return true;
        }

        result = default!;
        return false;
    }
}
