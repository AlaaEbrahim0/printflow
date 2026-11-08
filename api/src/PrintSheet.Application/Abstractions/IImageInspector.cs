namespace PrintSheet.Application.Abstractions;

/// <summary>Decodes image headers and confirms the file is a readable image.</summary>
public interface IImageInspector
{
    Task<ImageInspection> InspectAsync(Stream stream, CancellationToken cancellationToken);
}

/// <summary>Metadata used for intake validation and version-file verification.</summary>
public sealed record ImageInspection(
    int WidthPx,
    int HeightPx,
    bool HasAlpha,
    string Format,
    string ContentType,
    string FileExtension);
