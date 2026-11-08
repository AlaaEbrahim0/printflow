using System.Text.Json;
using PrintSheet.Domain.Batches;

namespace PrintSheet.Application.Jobs;

public sealed record JobAccepted(Guid JobId, JobStatus Status);

public sealed record ClaimJobsCommand(
    string WorkerId,
    IReadOnlyList<string> Capabilities,
    int LeaseSeconds);

public sealed record WorkerJobEnvelope(
    string SchemaVersion,
    Guid JobId,
    string Type,
    Guid BatchId,
    Guid DesignId,
    string InputPath,
    string? OutputPath,
    IReadOnlyDictionary<string, string> InputArtifacts,
    IReadOnlyDictionary<string, string> OutputArtifacts,
    JsonElement Parameters,
    JsonElement Context);

public sealed record ClaimedJob(
    string LeaseToken,
    DateTimeOffset LeaseExpiresAt,
    WorkerJobEnvelope Job);

public sealed record VersionFile(Stream Stream, string ContentType, string FileName);

public sealed record ArtifactFile(Stream Stream, string ContentType, string FileName);
