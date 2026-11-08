using System.Text.Json;
using System.Text.Json.Serialization;

namespace PrintSheet.Application.Common;

/// <summary>Shared JSON policy for contract-shaped payloads (camelCase, omit nulls).</summary>
public static class ApplicationJson
{
    public static JsonSerializerOptions Options { get; } = Create(ignoreNulls: true);

    public static JsonSerializerOptions Web { get; } = Create(ignoreNulls: false);

    private static JsonSerializerOptions Create(bool ignoreNulls)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            WriteIndented = false,
        };
        if (ignoreNulls)
        {
            options.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        }

        return options;
    }
}
