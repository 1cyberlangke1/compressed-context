/**
 * 多模态附件 token 估算。
 *
 * 输入：mime、base64/字节数据、可选时长。
 * 输出：粗略 token 数。
 * 预期：拿不到宽高/页数/时长时使用保守固定值；这里只做估算，不伪装成精确 tokenizer。
 */

/** 图片拿不到尺寸时的固定估算。 */
export const IMAGE_FALLBACK_TOKENS = 1_500
/** PDF 拿不到页数时的固定估算。 */
export const PDF_FALLBACK_TOKENS = 2_000
/** PDF 每页按一张图估算。 */
export const PDF_PAGE_TOKENS = 1_500
/** 音频每秒估算。 */
export const AUDIO_TOKENS_PER_SECOND = 32
/** 音频拿不到时长时的固定估算。 */
export const AUDIO_FALLBACK_TOKENS = 1_000
/** 视频每秒估算。 */
export const VIDEO_TOKENS_PER_SECOND = 263
/** 视频拿不到时长时的固定估算。 */
export const VIDEO_FALLBACK_TOKENS = 10_000
/** 未知二进制文件固定估算。 */
export const FILE_FALLBACK_TOKENS = 2_000

export interface AttachmentInput {
  readonly mime?: string | undefined
  readonly data?: string | Uint8Array | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly durationSeconds?: number | undefined
}

export interface ImageSize {
  readonly width: number
  readonly height: number
}

/** 输入：base64 或字节；输出：字节；失败返回 undefined。 */
function toBytes(data: string | Uint8Array | undefined): Uint8Array | undefined {
  if (data === undefined) return undefined
  if (data instanceof Uint8Array) return data
  try {
    return Uint8Array.from(Buffer.from(data, "base64"))
  } catch {
    return undefined
  }
}

/** 输入：字节 + 偏移；输出：大端 u32；越界返回 0。 */
function u32be(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset] ?? 0
  const b = bytes[offset + 1] ?? 0
  const c = bytes[offset + 2] ?? 0
  const d = bytes[offset + 3] ?? 0
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

/** 输入：字节 + 偏移；输出：小端 u16；越界返回 0。 */
function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

/** 输入：字节 + 偏移；输出：大端 u16；越界返回 0。 */
function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

/** 输入：字节 + 偏移；输出：小端 u24；越界返回 0。 */
function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

/** 输入：PNG 字节；输出：尺寸；不是 PNG 返回 undefined。 */
function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24) return undefined
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((value, index) => bytes[index] === value)) return undefined
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** 输入：GIF 字节；输出：尺寸；不是 GIF 返回 undefined。 */
function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined
  const header = String.fromCharCode(...bytes.slice(0, 6))
  if (header !== "GIF87a" && header !== "GIF89a") return undefined
  const width = u16le(bytes, 6)
  const height = u16le(bytes, 8)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** 输入：JPEG 字节；输出：尺寸；找不到 SOF 返回 undefined。 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    const length = u16be(bytes, offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(bytes, offset + 5)
      const width = u16be(bytes, offset + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/** 输入：WebP 字节；输出：尺寸；VP8X 之外的编码回退 undefined。 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) return undefined
  const riff = String.fromCharCode(...bytes.slice(0, 4))
  const webp = String.fromCharCode(...bytes.slice(8, 12))
  const chunk = String.fromCharCode(...bytes.slice(12, 16))
  if (riff !== "RIFF" || webp !== "WEBP" || chunk !== "VP8X") return undefined
  const width = 1 + u24le(bytes, 24)
  const height = 1 + u24le(bytes, 27)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** 输入：附件数据；输出：图片尺寸；不是图片或解析失败返回 undefined。 */
export function imageSize(data: string | Uint8Array | undefined): ImageSize | undefined {
  const bytes = toBytes(data)
  if (bytes === undefined) return undefined
  return pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes)
}

/** 输入：图片宽高；输出：通用经验公式估算。 */
export function imageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return IMAGE_FALLBACK_TOKENS
  return Math.max(258, Math.ceil((width * height) / 750))
}

/** 输入：PDF 字节；输出：页数；解析失败返回 undefined。 */
export function pdfPages(data: string | Uint8Array | undefined): number | undefined {
  const bytes = toBytes(data)
  if (bytes === undefined) return undefined
  const text = Buffer.from(bytes).toString("latin1")
  const pages = text.match(/\/Type\s*\/Page\b/g)
  return pages === null ? undefined : pages.length
}

/** 输入：文本类文件字节；输出：粗略 token。 */
function textFileTokens(bytes: Uint8Array): number {
  return Math.max(1, Math.ceil(bytes.length / 4))
}

/** 输入：附件；输出：通用经验估算。 */
export function attachmentTokens(input: AttachmentInput): number {
  const mime = (input.mime ?? "").toLowerCase()
  const bytes = toBytes(input.data)
  if (mime.startsWith("image/")) {
    if (input.width !== undefined && input.height !== undefined) {
      return imageTokens(input.width, input.height)
    }
    const size = imageSize(input.data)
    return size === undefined ? IMAGE_FALLBACK_TOKENS : imageTokens(size.width, size.height)
  }
  if (mime === "application/pdf") {
    const pages = pdfPages(input.data)
    return pages === undefined ? PDF_FALLBACK_TOKENS : pages * PDF_PAGE_TOKENS
  }
  if (mime.startsWith("audio/")) {
    return input.durationSeconds === undefined
      ? AUDIO_FALLBACK_TOKENS
      : Math.max(1, Math.ceil(input.durationSeconds * AUDIO_TOKENS_PER_SECOND))
  }
  if (mime.startsWith("video/")) {
    return input.durationSeconds === undefined
      ? VIDEO_FALLBACK_TOKENS
      : Math.max(1, Math.ceil(input.durationSeconds * VIDEO_TOKENS_PER_SECOND))
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    return bytes === undefined ? FILE_FALLBACK_TOKENS : textFileTokens(bytes)
  }
  return FILE_FALLBACK_TOKENS
}
