using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PrintSheet.Api;

/// <summary>
/// The contract requires ISO-8601 UTC timestamps ending in Z. System.Text.Json
/// writes DateTimeOffset offsets as +00:00, so normalise explicitly.
/// </summary>
public sealed class UtcDateTimeOffsetJsonConverter : JsonConverter<DateTimeOffset>
{
    private const string Format = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    public override DateTimeOffset Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
        => reader.GetDateTimeOffset();

    public override void Write(
        Utf8JsonWriter writer,
        DateTimeOffset value,
        JsonSerializerOptions options)
        => writer.WriteStringValue(value.UtcDateTime.ToString(Format, CultureInfo.InvariantCulture));
}
