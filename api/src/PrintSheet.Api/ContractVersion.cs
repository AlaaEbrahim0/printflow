namespace PrintSheet.Api;

/// <summary>
/// The contract version this build implements, reported by <c>/</c> and
/// <c>/api/v1/info</c>.
///
/// It is the single place the version is written in code: the contract validator
/// reads it back and fails when it disagrees with the OpenAPI document, so a
/// release can no longer advertise a version it does not serve.
/// </summary>
public static class ContractVersion
{
    public const string Current = "3.3.0";
}
