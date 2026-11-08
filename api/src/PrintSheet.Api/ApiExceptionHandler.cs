using Microsoft.AspNetCore.Diagnostics;
using Microsoft.EntityFrameworkCore;
using PrintSheet.Domain.Common;

namespace PrintSheet.Api;

/// <summary>Maps storage concurrency failures to the contract's 409 code.</summary>
public sealed class ApiExceptionHandler(ILogger<ApiExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        if (exception is not DbUpdateConcurrencyException)
        {
            return false;
        }

        logger.LogWarning(exception, "Concurrent update detected for {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status409Conflict;
        httpContext.Response.ContentType = "application/problem+json";
        await httpContext.Response.WriteAsJsonAsync(
            new
            {
                title = "Conflict",
                status = StatusCodes.Status409Conflict,
                detail = "The resource changed since it was loaded. Reload and retry.",
                code = ErrorCodes.ConcurrencyConflict,
            },
            cancellationToken);
        return true;
    }
}
