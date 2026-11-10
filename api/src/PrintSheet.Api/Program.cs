using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PrintSheet.Api;
using PrintSheet.Api.Endpoints;
using PrintSheet.Application;
using PrintSheet.Infrastructure;
using PrintSheet.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
    options.Limits.MaxRequestBodySize = 50L * 1024 * 1024);
builder.Services.Configure<FormOptions>(options =>
    options.MultipartBodyLengthLimit = 50L * 1024 * 1024);

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<ApiExceptionHandler>();
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new UtcDateTimeOffsetJsonConverter()));

var origins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>() ?? ["http://localhost:5173"];

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod());
});

builder.Services.AddPrintSheetInfrastructure(builder.Configuration);
builder.Services
    .AddHealthChecks()
    .AddDbContextCheck<PrintSheetDbContext>("database", tags: ["ready"]);

var app = builder.Build();

// The MVP has no migrations yet, so initialize the schema for either provider
// before serving requests or reporting the database as ready.
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<PrintSheetDbContext>();
    await db.Database.EnsureCreatedAsync();
}

app.UseExceptionHandler();
app.UseCors();

app.MapGet("/", () => Results.Ok(new
{
    service = "PrintSheet API",
    status = "Phase 2",
    contractVersion = "2.0.0",
}));

app.MapGet("/api/v1/info", () => Results.Ok(new
{
    service = "printsheet-api",
    version = typeof(ApplicationAssemblyMarker).Assembly.GetName().Version?.ToString() ?? "0.1.0",
    contractVersion = "2.0.0",
    phase = 2,
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

app.MapBatchEndpoints();
app.MapDesignEndpoints();
app.MapSheetEndpoints();
app.MapExportEndpoints();
app.MapJobEndpoints();
app.MapSystemEndpoints();

app.Run();

/// <summary>Exposed for WebApplicationFactory-based integration tests.</summary>
public partial class Program;
