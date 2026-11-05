using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PrintSheet.Application;
using PrintSheet.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();

var origins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>() ?? ["http://localhost:5173"];

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod());
});

var databaseProvider = builder.Configuration["Database:Provider"] ?? "Postgres";
var connectionString = builder.Configuration.GetConnectionString("PrintSheet")
    ?? throw new InvalidOperationException("ConnectionStrings:PrintSheet is required.");

builder.Services.AddDbContext<PrintSheetDbContext>(options =>
{
    if (databaseProvider.Equals("Sqlite", StringComparison.OrdinalIgnoreCase))
    {
        options.UseSqlite(connectionString);
    }
    else
    {
        options.UseNpgsql(connectionString);
    }
});

builder.Services
    .AddHealthChecks()
    .AddDbContextCheck<PrintSheetDbContext>("database", tags: ["ready"]);

var app = builder.Build();

app.UseExceptionHandler();
app.UseCors();

app.MapGet("/", () => Results.Ok(new
{
    service = "PrintSheet API",
    status = "Phase 0 skeleton",
    contractVersion = "1.0.0",
    documentation = "/docs/contracts/openapi/printsheet-api.yaml",
}));

app.MapGet("/api/v1/info", () => Results.Ok(new
{
    service = "printsheet-api",
    version = typeof(ApplicationAssemblyMarker).Assembly.GetName().Version?.ToString() ?? "0.1.0",
    contractVersion = "1.0.0",
    phase = 0,
}));

app.MapGet("/healthz", async (HealthCheckService healthChecks) =>
{
    var report = await healthChecks.CheckHealthAsync();
    var payload = new
    {
        status = report.Status.ToString(),
        service = "printsheet-api",
        checks = report.Entries.Select(entry => new
        {
            name = entry.Key,
            status = entry.Value.Status.ToString(),
            durationMs = (long)entry.Value.Duration.TotalMilliseconds,
        }),
    };

    return Results.Json(
        payload,
        statusCode: report.Status == HealthStatus.Healthy
            ? StatusCodes.Status200OK
            : StatusCodes.Status503ServiceUnavailable);
});

app.Run();

/// <summary>Exposed for WebApplicationFactory-based integration tests in Phase 1.</summary>
public partial class Program;
