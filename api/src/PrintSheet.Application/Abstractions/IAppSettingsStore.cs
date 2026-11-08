using PrintSheet.Application.Settings;

namespace PrintSheet.Application.Abstractions;

/// <summary>Singleton settings store.</summary>
public interface IAppSettingsStore
{
    Task<AppSettings> GetAsync(CancellationToken cancellationToken);

    Task SaveAsync(AppSettings settings, CancellationToken cancellationToken);
}
