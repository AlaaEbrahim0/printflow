using PrintSheet.Domain.Common;

namespace PrintSheet.Domain.Batches;

public sealed record Money
{
    private Money(decimal amount, string currency)
    {
        Amount = amount;
        Currency = currency;
    }

    /// <summary>For EF Core materialisation only.</summary>
    private Money()
    {
        Currency = "EUR";
    }

    public decimal Amount { get; }

    public string Currency { get; }

    public static Result<Money> Create(decimal amount, string currency)
    {
        if (amount < 0)
        {
            return Result<Money>.Failure(
                ErrorCodes.InvalidRequest,
                "Amount must not be negative.");
        }

        if (string.IsNullOrWhiteSpace(currency) || currency.Length != 3)
        {
            return Result<Money>.Failure(
                ErrorCodes.InvalidRequest,
                "Currency must be a three-letter code.");
        }

        return Result<Money>.Success(new Money(amount, currency.ToUpperInvariant()));
    }
}
