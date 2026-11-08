using System.Text.Json;
using PrintSheet.Domain.Batches;

namespace PrintSheet.Domain.Tests;

public sealed class CropRectTests
{
    [Fact]
    public void SerializationOmitsComputedAreaFromWorkerContractShape()
    {
        var rectangle = CropRect.Create(3, 5, 11, 13).Value!;
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        using var document = JsonDocument.Parse(JsonSerializer.Serialize(rectangle, options));

        Assert.Equal(
            new[] { "x", "y", "width", "height" },
            document.RootElement.EnumerateObject().Select(property => property.Name).ToArray());
    }
}
