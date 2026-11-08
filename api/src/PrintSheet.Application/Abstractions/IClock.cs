namespace PrintSheet.Application.Abstractions;

/// <summary>Testable UTC clock. All contract timestamps are ISO-8601 UTC.</summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
}
