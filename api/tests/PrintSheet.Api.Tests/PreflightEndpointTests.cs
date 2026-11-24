using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Preflight;
using PrintSheet.Infrastructure.Preflight;
using SkiaSharp;

namespace PrintSheet.Api.Tests;

/// <summary>
/// The preflight endpoint is the only way an operator can judge a file that is
/// not a version yet, so these tests drive it through the real pipeline: the
/// multipart form, the option parsing and the JSON the caller receives.
/// </summary>
public sealed class PreflightEndpointTests : IClassFixture<PreflightApiFactory>
{
    private readonly PreflightApiFactory _factory;

    public PreflightEndpointTests(PreflightApiFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task ReportsAPngThatIsNotAVersionYet()
    {
        using var client = _factory.CreateClient();
        using var content = Form(CutoutPng());
        content.Add(new StringContent("dark"), "garmentColorKind");
        content.Add(new StringContent("2.54"), "targetWidthCm");
        content.Add(new StringContent("2.54"), "targetHeightCm");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var report = body.RootElement.GetProperty("report");
        Assert.Equal("1.0", report.GetProperty("schemaVersion").GetString());
        Assert.Equal("dtf", report.GetProperty("profile").GetString());
        Assert.Equal("pass", report.GetProperty("verdict").GetString());
        Assert.Equal("dark", report.GetProperty("spec").GetProperty("garmentColor").GetString());
        Assert.False(body.RootElement.TryGetProperty("fixedImageBase64", out _));
    }

    [Fact]
    public async Task JudgesTheCanvasWhenNoTargetSizeIsGiven()
    {
        using var client = _factory.CreateClient();
        using var content = Form(CutoutPng());
        content.Add(new StringContent("300"), "dpi");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var spec = body.RootElement.GetProperty("report").GetProperty("spec");
        Assert.Equal(2.54m, spec.GetProperty("widthCm").GetDecimal());
        Assert.Equal(300, spec.GetProperty("dpi").GetInt32());
    }

    [Fact]
    public async Task FixTrueReturnsTheRepairedPngAndItsRecordedFixes()
    {
        using var client = _factory.CreateClient();
        using var content = Form(CutoutPng(includeMetadata: false));
        content.Add(new StringContent("true"), "fix");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var fixes = body.RootElement.GetProperty("report").GetProperty("fixes")
            .EnumerateArray()
            .Select(fix => fix.GetProperty("code").GetString())
            .ToArray();
        Assert.Contains(PreflightFixCodes.EmbedSrgb, fixes);
        Assert.Contains(PreflightFixCodes.SetDpiMetadata, fixes);

        var base64 = body.RootElement.GetProperty("fixedImageBase64").GetString();
        Assert.False(string.IsNullOrWhiteSpace(base64));
        var decoded = new SkiaPreflightImageCodec().Decode(Convert.FromBase64String(base64!));
        Assert.True(decoded.HasSrgbProfile);
    }

    [Fact]
    public async Task RejectsARequestWithoutAFile()
    {
        using var client = _factory.CreateClient();
        using var content = new MultipartFormDataContent();
        content.Add(new StringContent("dark"), "garmentColorKind");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unsupported-image", problem.GetProperty("code").GetString());
    }

    [Fact]
    public async Task RejectsAMalformedMultipartBodyAsAClientError()
    {
        // An empty multipart body makes the framework throw while reading the
        // form; that must surface as a 422, not an unhandled 500.
        using var client = _factory.CreateClient();
        using var content = new MultipartFormDataContent();

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid-request", problem.GetProperty("code").GetString());
    }

    [Fact]
    public async Task RejectsNonMultipartRequests()
    {
        using var client = _factory.CreateClient();
        using var content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid-request", problem.GetProperty("code").GetString());
    }

    [Fact]
    public async Task RejectsHalfATargetSize()
    {
        using var client = _factory.CreateClient();
        using var content = Form(CutoutPng());
        content.Add(new StringContent("10"), "targetWidthCm");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid-target-size", problem.GetProperty("code").GetString());
        Assert.Contains("both target dimensions", problem.GetProperty("detail").GetString()!);
    }

    [Fact]
    public async Task RejectsAnOutOfRangeDpi()
    {
        using var client = _factory.CreateClient();
        using var content = Form(CutoutPng());
        content.Add(new StringContent("5000"), "dpi");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid-target-size", problem.GetProperty("code").GetString());
    }

    [Fact]
    public async Task RejectsAnUnknownGarmentColour()
    {
        using var client = _factory.CreateClient();
        using var content = Form(CutoutPng());
        content.Add(new StringContent("tartan"), "garmentColorKind");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid-request", problem.GetProperty("code").GetString());
    }

    [Fact]
    public async Task RejectsAnUnknownProfileByName()
    {
        using var client = _factory.CreateClient();
        using var content = Form(CutoutPng());
        content.Add(new StringContent("screen-print"), "profile");

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("screen-print", problem.GetProperty("detail").GetString()!);
    }

    [Fact]
    public async Task RejectsAnUploadThatIsNotAPng()
    {
        using var client = _factory.CreateClient();
        using var content = Form([1, 2, 3, 4]);

        var response = await client.PostAsync("/api/v1/preflight", content);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unsupported-image", problem.GetProperty("code").GetString());
    }

    private static MultipartFormDataContent Form(byte[] bytes)
    {
        var content = new MultipartFormDataContent();
        var file = new ByteArrayContent(bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        content.Add(file, "file", "artwork.png");
        return content;
    }

    /// <summary>A hard-edged white square on a transparent canvas, 300 px square.</summary>
    private static byte[] CutoutPng(bool includeMetadata = true)
    {
        const int size = 300;
        var pixels = new byte[size * size * 4];
        for (var y = 100; y < 200; y++)
        {
            for (var x = 100; x < 200; x++)
            {
                var offset = (((y * size) + x) * 4);
                pixels[offset] = 255;
                pixels[offset + 1] = 255;
                pixels[offset + 2] = 255;
                pixels[offset + 3] = 255;
            }
        }

        var image = new PreflightImage(pixels, size, size, true, 8, true, 300, 300);
        var codec = new SkiaPreflightImageCodec();
        if (includeMetadata)
        {
            return codec.Encode(image);
        }

        using var bitmap = new SKBitmap(
            new SKImageInfo(size, size, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        System.Runtime.InteropServices.Marshal.Copy(pixels, 0, bitmap.GetPixels(), pixels.Length);
        using var skiaImage = SKImage.FromBitmap(bitmap);
        using var data = skiaImage.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}

/// <summary>
/// Boots the real API on SQLite in a throwaway directory. The cut-out worker is
/// disabled: these tests never queue a job, and a polling service would only add
/// background noise to the run.
/// </summary>
public sealed class PreflightApiFactory : WebApplicationFactory<Program>
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "printsheet-preflight-api-" + Guid.NewGuid().ToString("N"));

    protected override IHost CreateHost(IHostBuilder builder)
    {
        Directory.CreateDirectory(_root);
        builder.ConfigureHostConfiguration(configuration =>
            configuration.AddInMemoryCollection(
                new Dictionary<string, string?>
                {
                    ["Database:Provider"] = "Sqlite",
                    ["ConnectionStrings:PrintSheet"] =
                        $"Data Source={Path.Combine(_root, "preflight.db")}",
                    ["Storage:Root"] = Path.Combine(_root, "storage"),
                    ["BackgroundRemoval:RunJobs"] = "false",
                }));
        return base.CreateHost(builder);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
