using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.Services;
using PrintSheet.Infrastructure.Imaging;
using PrintSheet.Infrastructure.Persistence;
using PrintSheet.Infrastructure.Storage;

namespace PrintSheet.Infrastructure;

public static class DependencyInjection
{
    /// <summary>Composition root shared by the API and the integration tests.</summary>
    public static IServiceCollection AddPrintSheetInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var provider = configuration["Database:Provider"] ?? "Postgres";
        var connectionString = configuration.GetConnectionString("PrintSheet")
            ?? throw new InvalidOperationException("ConnectionStrings:PrintSheet is required.");

        services.AddDbContext<PrintSheetDbContext>(options =>
        {
            if (provider.Equals("Sqlite", StringComparison.OrdinalIgnoreCase))
            {
                options.UseSqlite(connectionString);
            }
            else
            {
                options.UseNpgsql(connectionString);
            }
        });

        services.AddSingleton(new StorageOptions
        {
            Root = configuration["Storage:Root"] ?? "storage",
        });
        services.AddSingleton<IFileStore, LocalFileStore>();
        services.AddSingleton<IImageInspector, SkiaImageInspector>();
        services.AddSingleton<IClock, SystemClock>();
        services.AddSingleton(_ => CreateIntakeOptions(configuration));

        services.AddScoped<IBatchRepository, EfBatchRepository>();
        services.AddScoped<IJobRepository, EfJobRepository>();
        services.AddScoped<IJobQueue, EfJobQueue>();
        services.AddScoped<IAppSettingsStore, EfAppSettingsStore>();

        services.AddScoped<BatchService>();
        services.AddScoped<DesignService>();
        services.AddScoped<VersionService>();
        services.AddScoped<StepService>();
        services.AddScoped<IntakeService>();
        services.AddScoped<SheetService>();
        services.AddScoped<ExportService>();
        services.AddScoped<SettingsService>();
        services.AddScoped<JobCompletionService>();
        services.AddScoped<JobService>();

        return services;
    }

    private static IntakeOptions CreateIntakeOptions(IConfiguration configuration)
    {
        var maxUploadBytes = long.TryParse(configuration["Intake:MaxUploadBytes"], out var parsedBytes)
            ? parsedBytes
            : 50L * 1024 * 1024;
        var maxDimensionPx = int.TryParse(configuration["Intake:MaxDimensionPx"], out var parsedDimension)
            ? parsedDimension
            : 30_000;

        return new IntakeOptions
        {
            MaxUploadBytes = maxUploadBytes,
            MaxDimensionPx = maxDimensionPx,
        };
    }
}
