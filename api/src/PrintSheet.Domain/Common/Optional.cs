namespace PrintSheet.Domain.Common;

/// <summary>
/// Distinguishes "property absent from a PATCH document" from "property
/// present with a null value". API models use it so a target size can be
/// cleared without also clearing fields the client did not mention.
/// </summary>
public readonly struct Optional<T>
{
    private Optional(bool hasValue, T? value)
    {
        HasValue = hasValue;
        Value = value;
    }

    public bool HasValue { get; }

    public T? Value { get; }

    public static Optional<T> Unset => default;

    public static Optional<T> Set(T? value) => new(true, value);
}
