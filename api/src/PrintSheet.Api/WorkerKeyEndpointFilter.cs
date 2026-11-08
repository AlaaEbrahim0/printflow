using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using PrintSheet.Api.Contracts;
using PrintSheet.Domain.Common;

namespace PrintSheet.Api;

/// <summary>
/// Shared-key protection for the internal worker protocol. The comparison is
/// constant time so a caller cannot probe the key byte by byte.
/// </summary>
public sealed class WorkerKeyEndpointFilter(IConfiguration configuration) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        var expected = configuration["Worker:Key"];
        var supplied = context.HttpContext.Request.Headers["X-Worker-Key"].ToString();

        if (string.IsNullOrEmpty(expected)
            || !FixedTimeEquals(expected, supplied))
        {
            return ApiResults.Problem(
                ErrorCodes.WorkerKeyInvalid,
                "A valid X-Worker-Key header is required.",
                401);
        }

        return await next(context);
    }

    private static bool FixedTimeEquals(string expected, string supplied)
    {
        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        var suppliedBytes = Encoding.UTF8.GetBytes(supplied);
        return expectedBytes.Length == suppliedBytes.Length
               && CryptographicOperations.FixedTimeEquals(expectedBytes, suppliedBytes);
    }
}

public static class RequestParsing
{
    public static bool TryGetDecimal(IFormCollection form, string key, out decimal? value)
    {
        value = null;
        var raw = form[key].ToString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        if (!decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed))
        {
            return false;
        }

        value = parsed;
        return true;
    }

    public static bool TryGetInt(IFormCollection form, string key, out int? value)
    {
        value = null;
        var raw = form[key].ToString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return false;
        }

        value = parsed;
        return true;
    }
}
