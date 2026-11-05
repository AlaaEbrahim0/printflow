using Microsoft.EntityFrameworkCore;

namespace PrintSheet.Infrastructure.Persistence;

/// <summary>
/// Phase 0 persistence shell. Aggregate mappings and migrations are added by
/// the API track in Phase 1; the context exists now so the container stack can
/// prove database connectivity from day one.
/// </summary>
public sealed class PrintSheetDbContext(DbContextOptions<PrintSheetDbContext> options)
    : DbContext(options)
{
}
