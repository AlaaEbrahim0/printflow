using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Settings;
using PrintSheet.Domain.Common;

namespace PrintSheet.Application.Services;

public sealed class SettingsService
{
    private readonly IAppSettingsStore _store;

    public SettingsService(IAppSettingsStore store)
    {
        _store = store;
    }

    public Task<AppSettings> GetAsync(CancellationToken cancellationToken)
        => _store.GetAsync(cancellationToken);

    public async Task<Result<AppSettings>> UpdateAsync(
        AppSettings settings,
        CancellationToken cancellationToken)
    {
        var validation = settings.Validate();
        if (!validation.IsSuccess)
        {
            return Result<AppSettings>.Failure(validation.Error!);
        }

        await _store.SaveAsync(settings, cancellationToken);
        return Result<AppSettings>.Success(settings);
    }
}
