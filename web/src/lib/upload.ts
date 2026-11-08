/**
 * Client-side intake validation. The API re-validates (MIME sniffing, decode,
 * dimension limits); this only fails fast before a large upload leaves the
 * browser. Mirrors the `upload-too-large` / `unsupported-image` problem codes.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/tiff'] as const

export const ACCEPTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'] as const

export const ACCEPT_ATTRIBUTE = [...ACCEPTED_MIME_TYPES, ...ACCEPTED_EXTENSIONS.map((e) => `.${e}`)].join(',')

export interface UploadRejection {
  code: 'upload-too-large' | 'unsupported-image'
  message: string
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

export function hasAcceptedExtension(name: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(fileExtension(name))
}

export function hasAcceptedMimeType(type: string): boolean {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(type.toLowerCase())
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Returns `null` when the file may be uploaded. */
export function validateUploadFile(
  file: File,
  maxBytes: number = MAX_UPLOAD_BYTES,
): UploadRejection | null {
  if (file.size > maxBytes) {
    return {
      code: 'upload-too-large',
      message: `${file.name} is ${formatBytes(file.size)} — the intake limit is ${formatBytes(maxBytes)}.`,
    }
  }
  const typeLooksUsable = file.type === '' || hasAcceptedMimeType(file.type)
  const nameLooksUsable = hasAcceptedExtension(file.name)
  if (!hasAcceptedMimeType(file.type) && !nameLooksUsable) {
    return {
      code: 'unsupported-image',
      message: `${file.name} is not a PNG, JPEG, WebP or TIFF image.`,
    }
  }
  if (!typeLooksUsable && nameLooksUsable) {
    return {
      code: 'unsupported-image',
      message: `${file.name} claims to be "${file.type || 'unknown'}". The API will reject it unless it decodes as an image.`,
    }
  }
  return null
}

export interface ImageSize {
  widthPx: number
  heightPx: number
}

/** Reads pixel dimensions locally so ready-to-pack print sizes can be previewed. */
export async function readImageSize(file: File): Promise<ImageSize | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(file)
    const size = { widthPx: bitmap.width, heightPx: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return null
  }
}

export function defaultDesignName(file: File): string {
  const index = file.name.lastIndexOf('.')
  const stem = index === -1 ? file.name : file.name.slice(0, index)
  return stem.slice(0, 200) || file.name.slice(0, 200)
}
