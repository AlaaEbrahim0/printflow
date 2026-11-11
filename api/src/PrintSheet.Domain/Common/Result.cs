namespace PrintSheet.Domain.Common;

/// <summary>
/// Stable machine-readable error codes exposed in ProblemDetails.code.
/// Keep these in sync with docs/domain-model.md section 9.
/// </summary>
public static class ErrorCodes
{
    public const string BatchNotFound = "batch-not-found";
    public const string DesignNotFound = "design-not-found";
    public const string VersionNotFound = "version-not-found";
    public const string JobNotFound = "job-not-found";
    public const string ExportNotFound = "export-not-found";
    public const string SheetNotFound = "sheet-not-found";
    public const string ProposalInFlight = "proposal-in-flight";
    public const string JobInFlight = "job-in-flight";
    public const string PendingProposal = "pending-proposal";
    public const string StaleProposal = "stale-proposal";
    public const string InvalidTransition = "invalid-transition";
    public const string VersionNotApproved = "version-not-approved";
    public const string DesignNotReady = "design-not-ready";
    public const string DesignExceedsRoll = "design-exceeds-roll";
    public const string BatchNotReady = "batch-not-ready";
    public const string BatchHasNoDesigns = "batch-has-no-designs";
    public const string SheetStale = "sheet-stale";
    public const string SheetIntegrityFailed = "sheet-integrity-failed";
    public const string StaleRevision = "stale-revision";
    public const string StaleSource = "stale-source";
    public const string InvalidTargetSize = "invalid-target-size";
    public const string InvalidRequest = "invalid-request";
    public const string ExportFormatUnavailable = "export-format-unavailable";
    public const string WorkerKeyInvalid = "worker-key-invalid";
    public const string UploadTooLarge = "upload-too-large";
    public const string UnsupportedImage = "unsupported-image";
    public const string LeaseInvalid = "lease-invalid";
    public const string JobNotCancellable = "job-not-cancellable";
    public const string ConcurrencyConflict = "concurrency-conflict";
    public const string BatchImageDeleted = "batch-images-deleted";
    public const string BatchDeleted = "batch-deleted";
    public const string BatchInUse = "batch-in-use";
}

/// <summary>An expected, user-visible failure. Not an exception.</summary>
public sealed record DomainError(
    string Code,
    string Message,
    IReadOnlyDictionary<string, object?>? Details = null)
{
    public static DomainError Create(string code, string message)
        => new(code, message);

    public static DomainError Create(
        string code,
        string message,
        IReadOnlyDictionary<string, object?> details)
        => new(code, message, details);
}

/// <summary>Result of a domain operation that may fail for expected reasons.</summary>
public readonly struct Result
{
    private Result(bool isSuccess, DomainError? error)
    {
        IsSuccess = isSuccess;
        Error = error;
    }

    public bool IsSuccess { get; }

    public DomainError? Error { get; }

    public static Result Success() => new(true, null);

    public static Result Failure(DomainError error) => new(false, error);

    public static Result Failure(string code, string message) =>
        new(false, DomainError.Create(code, message));

    public static Result Failure(
        string code,
        string message,
        IReadOnlyDictionary<string, object?> details) =>
        new(false, DomainError.Create(code, message, details));
}

/// <summary>Result carrying a value on success.</summary>
public readonly struct Result<T>
{
    private Result(T? value, DomainError? error)
    {
        Value = value;
        Error = error;
    }

    public T? Value { get; }

    public DomainError? Error { get; }

    public bool IsSuccess => Error is null;

    public static Result<T> Success(T value) => new(value, null);

    public static Result<T> Failure(DomainError error) => new(default, error);

    public static Result<T> Failure(string code, string message) =>
        new(default, DomainError.Create(code, message));

    public static Result<T> Failure(
        string code,
        string message,
        IReadOnlyDictionary<string, object?> details) =>
        new(default, DomainError.Create(code, message, details));
}
