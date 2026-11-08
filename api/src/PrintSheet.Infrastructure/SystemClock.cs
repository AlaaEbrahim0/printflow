using PrintSheet.Application.Abstractions;

namespace PrintSheet.Infrastructure;

/// <summary>System UTC clock. Tests replace this with a deterministic clock.</summary>
public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}
