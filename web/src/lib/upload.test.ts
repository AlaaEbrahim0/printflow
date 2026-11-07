import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_MIME_TYPES,
  ACCEPT_ATTRIBUTE,
  MAX_UPLOAD_BYTES,
  defaultDesignName,
  fileExtension,
  formatBytes,
  hasAcceptedExtension,
  hasAcceptedMimeType,
  validateUploadFile,
} from './upload'

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('intake validation', () => {
  it('accepts the four contract image types', () => {
    for (const type of ACCEPTED_MIME_TYPES) {
      expect(validateUploadFile(makeFile('art.bin', type, 1024))).toBeNull()
    }
    expect(ACCEPT_ATTRIBUTE).toContain('.png')
    expect(ACCEPT_ATTRIBUTE).toContain('image/tiff')
  })

  it('rejects a file that is both the wrong type and the wrong extension', () => {
    const rejection = validateUploadFile(makeFile('invoice.pdf', 'application/pdf', 1024))
    expect(rejection?.code).toBe('unsupported-image')
    expect(rejection?.message).toContain('invoice.pdf')
  })

  it('trusts the extension when the browser reports no MIME type', () => {
    expect(validateUploadFile(makeFile('screenshot.png', '', 1024))).toBeNull()
    expect(validateUploadFile(makeFile('scan.jpg', '', 1024))).toBeNull()
    expect(validateUploadFile(makeFile('mystery', '', 1024))?.code).toBe('unsupported-image')
  })

  it('flags a mismatched type that the API will decide on', () => {
    const rejection = validateUploadFile(makeFile('tricky.png', 'application/octet-stream', 1024))
    expect(rejection?.code).toBe('unsupported-image')
    expect(rejection?.message).toContain('API will reject it')
  })

  it('rejects oversized uploads before any byte is sent, with the size spelled out', () => {
    const rejection = validateUploadFile(makeFile('big.png', 'image/png', MAX_UPLOAD_BYTES + 1))
    expect(rejection?.code).toBe('upload-too-large')
    expect(rejection?.message).toContain('25.0 MB')
  })

  it('honours a caller-supplied limit', () => {
    expect(validateUploadFile(makeFile('ok.png', 'image/png', 2048), 1024)?.code).toBe(
      'upload-too-large',
    )
  })

  it('derives a sane default design name from the file', () => {
    expect(defaultDesignName(makeFile('ACME back print@2x.png', 'image/png', 10))).toBe(
      'ACME back print@2x',
    )
    expect(defaultDesignName(makeFile('no-extension', 'image/png', 10))).toBe('no-extension')
    expect(defaultDesignName(makeFile(`${'x'.repeat(300)}.png`, 'image/png', 10))).toHaveLength(200)
  })

  it('exposes the helpers the upload panel renders', () => {
    expect(fileExtension('A.B.PNG')).toBe('png')
    expect(fileExtension('noext')).toBe('')
    expect(hasAcceptedExtension('logo.webp')).toBe(true)
    expect(hasAcceptedExtension('notes.txt')).toBe(false)
    expect(hasAcceptedMimeType('IMAGE/PNG')).toBe(true)
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe('25.0 MB')
  })
})
