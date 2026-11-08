namespace PrintSheet.Domain.Batches;

/// <summary>Append-only audit record for a domain transition.</summary>
public sealed class AuditEntry
{
    private AuditEntry()
    {
        Action = string.Empty;
        Actor = string.Empty;
    }

    private AuditEntry(
        Guid id,
        Guid batchId,
        Guid? designId,
        Guid? versionId,
        string action,
        string actor,
        string? reason,
        string? detailsJson,
        DateTimeOffset createdAt)
    {
        Id = id;
        BatchId = batchId;
        DesignId = designId;
        VersionId = versionId;
        Action = action;
        Actor = actor;
        Reason = reason;
        DetailsJson = detailsJson;
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }

    public Guid BatchId { get; private set; }

    public Guid? DesignId { get; private set; }

    public Guid? VersionId { get; private set; }

    public string Action { get; private set; }

    public string Actor { get; private set; }

    public string? Reason { get; private set; }

    public string? DetailsJson { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public static AuditEntry Create(
        Guid batchId,
        Guid? designId,
        Guid? versionId,
        string action,
        string actor,
        string? reason,
        string? detailsJson,
        DateTimeOffset createdAt)
        => new(
            Guid.NewGuid(),
            batchId,
            designId,
            versionId,
            action,
            string.IsNullOrWhiteSpace(actor) ? "operator" : actor,
            reason,
            detailsJson,
            createdAt);
}
