using PrintSheet.Domain.Common;
using PrintSheet.Domain.Units;

namespace PrintSheet.Domain.Batches;

/// <summary>
/// One customer artwork inside a batch. Owns immutable versions and mutable
/// pointers: current (approved pixels) and pending (at most one proposal).
/// </summary>
public sealed class Design
{
    private readonly List<DesignVersion> _versions = [];

    private Design()
    {
        Name = string.Empty;
    }

    private Design(
        Guid id,
        Guid batchId,
        string name,
        GarmentColor garmentColor,
        bool allowRotation,
        decimal? targetWidthCm,
        decimal? targetHeightCm,
        string? notes,
        DesignVersion original,
        int workingDpi,
        DateTimeOffset createdAt)
    {
        Id = id;
        BatchId = batchId;
        Name = name;
        Status = DesignStatus.Received;
        GarmentColor = garmentColor;
        AllowRotation = allowRotation;
        TargetWidthCm = targetWidthCm;
        TargetHeightCm = targetHeightCm;
        Notes = notes;
        OriginalVersionId = original.Id;
        CurrentVersionId = original.Id;
        WorkingDpi = workingDpi;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
        _versions.Add(original);
    }

    public Guid Id { get; private set; }

    public Guid BatchId { get; private set; }

    public string Name { get; private set; }

    public DesignStatus Status { get; private set; }

    public GarmentColor GarmentColor { get; private set; } = GarmentColor.Light;

    public bool AllowRotation { get; private set; }

    public decimal? TargetWidthCm { get; private set; }

    public decimal? TargetHeightCm { get; private set; }

    public Guid OriginalVersionId { get; private set; }

    public Guid CurrentVersionId { get; private set; }

    public Guid? PendingVersionId { get; private set; }

    public bool BetterSourceRequested { get; private set; }

    public string? Notes { get; private set; }

    public int WorkingDpi { get; private set; }

    /// <summary>Raw classifier payload (source/features/suggestions), if any.</summary>
    public string? SuggestionsJson { get; private set; }

    /// <summary>pending | ready | failed, or null before the first result.</summary>
    public string? SuggestionsStatus { get; private set; }

    public DateTimeOffset? SuggestionsAnalyzedAt { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    public IReadOnlyList<DesignVersion> Versions => _versions;

    public int VersionCount => _versions.Count;

    public DesignVersion? CurrentVersion => _versions.FirstOrDefault(v => v.Id == CurrentVersionId);

    public DesignVersion? PendingVersion => _versions.FirstOrDefault(v => v.Id == PendingVersionId);

    public bool IsReady => Status == DesignStatus.Ready;

    /// <summary>
    /// Lower of horizontal and vertical effective resolution of the current
    /// version at the declared target size, or null until a target is set.
    /// </summary>
    public decimal? EffectiveDpi
    {
        get
        {
            var version = CurrentVersion;
            if (version is null || TargetWidthCm is null || TargetHeightCm is null)
            {
                return null;
            }

            var horizontal = PrintUnits.EffectiveDpi(version.WidthPx, TargetWidthCm.Value);
            var vertical = PrintUnits.EffectiveDpi(version.HeightPx, TargetHeightCm.Value);
            return Math.Min(horizontal, vertical);
        }
    }

    public static Result<Design> Create(
        Guid id,
        Guid batchId,
        string name,
        GarmentColor garmentColor,
        bool allowRotation,
        decimal? targetWidthCm,
        decimal? targetHeightCm,
        string? notes,
        DesignVersion original,
        int workingDpi,
        DateTimeOffset createdAt)
    {
        if (id == Guid.Empty || batchId == Guid.Empty)
        {
            return Result<Design>.Failure(ErrorCodes.InvalidRequest, "Design and batch ids are required.");
        }

        var nameError = ValidateName(name);
        if (nameError is not null)
        {
            return Result<Design>.Failure(nameError);
        }

        if (notes is { Length: > 2000 })
        {
            return Result<Design>.Failure(
                ErrorCodes.InvalidRequest,
                "Notes must be at most 2000 characters.");
        }

        var targetError = ValidateTarget(targetWidthCm, targetHeightCm);
        if (targetError is not null)
        {
            return Result<Design>.Failure(targetError);
        }

        if (original.DesignId != id
            || original.StepType != StepType.Original
            || original.Status != VersionStatus.Approved
            || original.ParentId is not null)
        {
            return Result<Design>.Failure(
                ErrorCodes.InvalidRequest,
                "A design must start with one approved original version.");
        }

        if (workingDpi is < 72 or > 1200)
        {
            return Result<Design>.Failure(ErrorCodes.InvalidRequest, "Working DPI is out of range.");
        }

        return Result<Design>.Success(new Design(
            id,
            batchId,
            name.Trim(),
            garmentColor,
            allowRotation,
            targetWidthCm,
            targetHeightCm,
            notes,
            original,
            workingDpi,
            createdAt));
    }

    public DesignVersion? FindVersion(Guid versionId)
        => _versions.FirstOrDefault(version => version.Id == versionId);

    /// <summary>
    /// Adds the single proposal produced by a worker. The parent must still be
    /// current; a stale result is rejected instead of being rebased.
    /// </summary>
    public Result AddProposal(DesignVersion proposal, DateTimeOffset at)
    {
        if (Status is DesignStatus.Excluded or DesignStatus.NeedsBetterSource)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Design {Id} is {Status.ToContract()} and cannot accept a proposal.");
        }

        if (PendingVersionId is not null)
        {
            return Result.Failure(
                ErrorCodes.ProposalInFlight,
                "A proposed version already exists for this design.");
        }

        if (proposal.DesignId != Id || proposal.StepType == StepType.Original)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Proposal does not belong to this design.");
        }

        if (proposal.Status != VersionStatus.Proposed)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "A proposal must start as proposed.");
        }

        if (proposal.ParentId != CurrentVersionId)
        {
            return Result.Failure(
                ErrorCodes.StaleProposal,
                "The proposal's parent is no longer the current version; reject it and run the step again.");
        }

        _versions.Add(proposal);
        PendingVersionId = proposal.Id;
        UpdatedAt = at;
        return Result.Success();
    }

    /// <summary>
    /// Adds an externally prepared, already-approved resize version whose file
    /// is the operator's exported ready-to-pack PNG. The target dimensions must
    /// match its pixels exactly so the packer never resamples it.
    /// </summary>
    public Result MarkReady(DesignVersion prepared, DateTimeOffset at)
    {
        if (prepared.DesignId != Id)
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "The prepared version does not belong to this design.");
        }

        if (prepared.StepType != StepType.Resize || prepared.Status != VersionStatus.Approved)
        {
            return Result.Failure(
                ErrorCodes.InvalidRequest,
                "A ready-to-pack version must be an approved resize.");
        }

        if (prepared.ParentId != CurrentVersionId)
        {
            return Result.Failure(
                ErrorCodes.InvalidRequest,
                "The ready-to-pack version must be derived from the current original.");
        }

        if (PendingVersionId is not null)
        {
            return Result.Failure(
                ErrorCodes.ProposalInFlight,
                "A proposed version already exists for this design.");
        }

        var targetError = ValidateResizeMatchesTarget(prepared);
        if (targetError is not null)
        {
            return Result.Failure(targetError);
        }

        _versions.Add(prepared);
        CurrentVersionId = prepared.Id;
        RecomputeStatus();
        UpdatedAt = at;
        return Result.Success();
    }

    public Result ApproveVersion(Guid versionId, DateTimeOffset at)
    {
        var version = FindVersion(versionId);
        if (version is null)
        {
            return Result.Failure(ErrorCodes.VersionNotFound, $"Version {versionId} was not found.");
        }

        if (version.Status != VersionStatus.Proposed)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Only a proposed version can be approved (current status: {version.Status.ToContract()}).");
        }

        if (version.ParentId != CurrentVersionId)
        {
            version.Reject("stale-parent", at);
            PendingVersionId = null;
            UpdatedAt = at;
            return Result.Failure(
                ErrorCodes.StaleProposal,
                "The proposal's parent is no longer current; it was rejected as stale.");
        }

        if (version.StepType == StepType.Resize)
        {
            var targetError = ValidateResizeMatchesTarget(version);
            if (targetError is not null)
            {
                return Result.Failure(targetError);
            }
        }

        var approved = version.Approve(at);
        if (!approved.IsSuccess)
        {
            return approved;
        }

        CurrentVersionId = version.Id;
        PendingVersionId = null;
        RecomputeStatus();
        UpdatedAt = at;
        return Result.Success();
    }

    public Result RejectVersion(Guid versionId, string? reason, DateTimeOffset at)
    {
        var version = FindVersion(versionId);
        if (version is null)
        {
            return Result.Failure(ErrorCodes.VersionNotFound, $"Version {versionId} was not found.");
        }

        if (version.Status != VersionStatus.Proposed)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                $"Only a proposed version can be rejected (current status: {version.Status.ToContract()}).");
        }

        if (reason is { Length: > 2000 })
        {
            return Result.Failure(ErrorCodes.InvalidRequest, "Rejection reason is too long.");
        }

        var rejected = version.Reject(reason, at);
        if (!rejected.IsSuccess)
        {
            return rejected;
        }

        if (PendingVersionId == version.Id)
        {
            PendingVersionId = null;
        }

        UpdatedAt = at;
        return Result.Success();
    }

    /// <summary>Moves the current pointer; never creates or deletes a version.</summary>
    public Result RevertTo(Guid targetVersionId, DateTimeOffset at)
    {
        var target = FindVersion(targetVersionId);
        if (target is null)
        {
            return Result.Failure(
                ErrorCodes.VersionNotFound,
                $"Version {targetVersionId} was not found.");
        }

        if (target.Status != VersionStatus.Approved)
        {
            return Result.Failure(
                ErrorCodes.VersionNotApproved,
                "Revert targets must be approved versions.");
        }

        if (target.Id == CurrentVersionId)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                "The requested version is already current.");
        }

        if (PendingVersionId is { } pending)
        {
            FindVersion(pending)?.Reject("stale-parent", at);
            PendingVersionId = null;
        }

        CurrentVersionId = target.Id;
        RecomputeStatus();
        UpdatedAt = at;
        return Result.Success();
    }

    public Result UpdateMetadata(
        Optional<string> name,
        Optional<GarmentColor> garmentColor,
        Optional<bool> allowRotation,
        Optional<decimal?> targetWidthCm,
        Optional<decimal?> targetHeightCm,
        Optional<string?> notes,
        DateTimeOffset at)
    {
        if (name.HasValue)
        {
            var nameError = ValidateName(name.Value);
            if (nameError is not null)
            {
                return Result.Failure(nameError);
            }

            Name = name.Value!.Trim();
        }

        if (garmentColor.HasValue)
        {
            if (garmentColor.Value is null)
            {
                return Result.Failure(
                    ErrorCodes.InvalidRequest,
                    "Garment colour cannot be cleared.");
            }

            GarmentColor = garmentColor.Value;
        }

        if (allowRotation.HasValue)
        {
            AllowRotation = allowRotation.Value;
        }

        var nextWidth = targetWidthCm.HasValue ? targetWidthCm.Value : TargetWidthCm;
        var nextHeight = targetHeightCm.HasValue ? targetHeightCm.Value : TargetHeightCm;
        var targetError = ValidateTarget(nextWidth, nextHeight);
        if (targetError is not null)
        {
            return Result.Failure(targetError);
        }

        if (targetWidthCm.HasValue)
        {
            TargetWidthCm = targetWidthCm.Value;
        }

        if (targetHeightCm.HasValue)
        {
            TargetHeightCm = targetHeightCm.Value;
        }

        if (notes.HasValue)
        {
            if (notes.Value is { Length: > 2000 })
            {
                return Result.Failure(ErrorCodes.InvalidRequest, "Notes must be at most 2000 characters.");
            }

            Notes = notes.Value;
        }

        RecomputeStatus();
        UpdatedAt = at;
        return Result.Success();
    }

    public Result Exclude(DateTimeOffset at)
    {
        if (Status == DesignStatus.Excluded)
        {
            return Result.Failure(ErrorCodes.InvalidTransition, "The design is already excluded.");
        }

        Status = DesignStatus.Excluded;
        UpdatedAt = at;
        return Result.Success();
    }

    public Result Include(DateTimeOffset at)
    {
        if (Status != DesignStatus.Excluded)
        {
            return Result.Failure(ErrorCodes.InvalidTransition, "Only an excluded design can be included.");
        }

        Status = DesignStatus.InProgress;
        RecomputeStatus();
        UpdatedAt = at;
        return Result.Success();
    }

    public Result RequestBetterSource(DateTimeOffset at)
    {
        if (BetterSourceRequested)
        {
            return Result.Success();
        }

        BetterSourceRequested = true;
        RecomputeStatus();
        UpdatedAt = at;
        return Result.Success();
    }

    public Result Resume(DateTimeOffset at)
    {
        if (!BetterSourceRequested)
        {
            return Result.Failure(
                ErrorCodes.InvalidTransition,
                "The design is not waiting for a better source.");
        }

        BetterSourceRequested = false;
        RecomputeStatus();
        UpdatedAt = at;
        return Result.Success();
    }

    public void SetSuggestions(string suggestionsJson, DateTimeOffset at)
    {
        SuggestionsJson = suggestionsJson;
        SuggestionsStatus = "ready";
        SuggestionsAnalyzedAt = at;
        UpdatedAt = at;
    }

    public void MarkSuggestionsFailed(DateTimeOffset at)
    {
        SuggestionsJson = null;
        SuggestionsStatus = "failed";
        SuggestionsAnalyzedAt = at;
        UpdatedAt = at;
    }

    private DomainError? ValidateResizeMatchesTarget(DesignVersion version)
    {
        if (TargetWidthCm is null || TargetHeightCm is null)
        {
            return DomainError.Create(
                ErrorCodes.InvalidTargetSize,
                "Set the target width and height before approving a resize.");
        }

        var expectedWidth = PrintUnits.PixelsForCentimeters(TargetWidthCm.Value, WorkingDpi);
        var expectedHeight = PrintUnits.PixelsForCentimeters(TargetHeightCm.Value, WorkingDpi);
        if (version.WidthPx != expectedWidth || version.HeightPx != expectedHeight)
        {
            return DomainError.Create(
                ErrorCodes.InvalidTargetSize,
                $"The resize is {version.WidthPx}x{version.HeightPx} px but the target requires "
                + $"{expectedWidth}x{expectedHeight} px at {WorkingDpi} DPI.");
        }

        return null;
    }

    private void RecomputeStatus()
    {
        if (Status == DesignStatus.Excluded)
        {
            return;
        }

        if (BetterSourceRequested)
        {
            Status = DesignStatus.NeedsBetterSource;
            return;
        }

        var current = CurrentVersion;
        if (current is null)
        {
            Status = DesignStatus.Received;
            return;
        }

        if (current.StepType == StepType.Resize && MatchesTarget(current))
        {
            Status = DesignStatus.Ready;
            return;
        }

        Status = current.StepType == StepType.Original
            ? DesignStatus.Received
            : DesignStatus.InProgress;
    }

    private bool MatchesTarget(DesignVersion version)
    {
        if (TargetWidthCm is null || TargetHeightCm is null)
        {
            return false;
        }

        return version.WidthPx == PrintUnits.PixelsForCentimeters(TargetWidthCm.Value, WorkingDpi)
               && version.HeightPx == PrintUnits.PixelsForCentimeters(TargetHeightCm.Value, WorkingDpi);
    }

    private static DomainError? ValidateName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return DomainError.Create(ErrorCodes.InvalidRequest, "Design name is required.");
        }

        if (name.Length > 200)
        {
            return DomainError.Create(
                ErrorCodes.InvalidRequest,
                "Design name must be at most 200 characters.");
        }

        return null;
    }

    private static DomainError? ValidateTarget(decimal? widthCm, decimal? heightCm)
    {
        if (widthCm is <= 0m or > 500m)
        {
            return DomainError.Create(
                ErrorCodes.InvalidTargetSize,
                "Target width must be greater than 0 and at most 500 cm.");
        }

        if (heightCm is <= 0m or > 500m)
        {
            return DomainError.Create(
                ErrorCodes.InvalidTargetSize,
                "Target height must be greater than 0 and at most 500 cm.");
        }

        return null;
    }
}
