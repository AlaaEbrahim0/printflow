using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Settings;

namespace PrintSheet.Infrastructure.Persistence;

/// <summary>Settings are a singleton JSON row so new fields do not need migrations.</summary>
public sealed class EfAppSettingsStore(PrintSheetDbContext db, IClock clock) : IAppSettingsStore
{
    private const string RowId = "default";

    public async Task<AppSettings> GetAsync(CancellationToken cancellationToken)
    {
        var row = await db.AppSettings.FindAsync([RowId], cancellationToken);
        if (row is null)
        {
            return AppSettings.Default;
        }

        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<AppSettings>(
                       row.Json,
                       Application.Common.ApplicationJson.Web)
                   ?? AppSettings.Default;
        }
        catch (System.Text.Json.JsonException)
        {
            return AppSettings.Default;
        }
    }

    public async Task SaveAsync(AppSettings settings, CancellationToken cancellationToken)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(
            settings,
            Application.Common.ApplicationJson.Web);
        var row = await db.AppSettings.FindAsync([RowId], cancellationToken);
        if (row is null)
        {
            db.AppSettings.Add(new AppSettingsRecord
            {
                Id = RowId,
                Json = json,
                UpdatedAt = clock.UtcNow,
            });
        }
        else
        {
            row.Json = json;
            row.UpdatedAt = clock.UtcNow;
        }

        await db.SaveChangesAsync(cancellationToken);
    }
}
