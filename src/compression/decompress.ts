/**
 * 解压：把已压缩块的内容还给模型。
 *
 * - `full:false`（默认）展开一层：合并块返回直接子块的摘要；T1 块返回磁盘原文。
 * - `full:true` 递归到 T1，原文从插件自己的 transcript storage 读取。
 * - 媒体 bytes/base64 写临时文件；url/ref/缺失内容输出占位符。
 * - 返回分级：≤ INLINE_MAX 字符内联进 tool result；超出边读边写 `os.tmpdir()` 文件并回路径，
 *   模型用 read 工具打开。临时文件有 reaper（上限 TEMP_CAP，删最老），防无限堆积。
 * - copy-paste 语义：不修改任何块状态；块保持折叠，内容只是 tool result 文本。
 */

import { appendFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { countText } from "../shared/tokens.ts"
import type { Block, StorageLike } from "./state.ts"
import { loadState } from "./state.ts"
import { renderBlock } from "./render.ts"
import {
  loadTranscriptManifest,
  loadTranscriptMessage,
  type StoredMessage,
  type StoredPart,
} from "./transcript-store.ts"

/** 内联返回的默认字符上限；运行时由设置覆盖。 */
export const INLINE_MAX = 10_000
/** 临时文件数量默认上限；运行时由设置覆盖。 */
export const TEMP_CAP = 50

/** decompress 的运行时限制。 */
export interface DecompressLimits {
  readonly inlineMax: number
  readonly tempCap: number
  readonly showTokens: boolean
}

const DEFAULT_LIMITS: DecompressLimits = {
  inlineMax: INLINE_MAX,
  tempCap: TEMP_CAP,
  showTokens: true,
}

/** 解压工具结果；ok 时 inline 或 path 至少一项存在。 */
export type DecompressResult =
  | { readonly status: "ok"; readonly inline: string; readonly path?: string; readonly tokens?: number }
  | { readonly status: "error"; readonly message: string }

const tempFiles: { path: string; mtimeMs: number; sessionID: string }[] = []

/** 输入：上限；输出：清理过期临时文件。预期：超上限删最老，绝不抛错。 */
function reapTempFiles(cap: number): void {
  while (tempFiles.length > cap) {
    tempFiles.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const oldest = tempFiles.shift()
    if (oldest === undefined) break
    try {
      unlinkSync(oldest.path)
    } catch {
      // 已被外部清理或权限问题：跳过，不阻塞解压
    }
  }
}

/** 输入：会话 + 块 id + 正文 + 上限；输出：临时文件路径。 */
function writeTempFile(sessionID: string, blockId: string, body: string, cap: number): string {
  const safeId = blockId.replace(/[^a-zA-Z0-9_-]/g, "-")
  const path = join(tmpdir(), `compressed-context-decompress-${safeId}-${String(Date.now())}.txt`)
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 })
  tempFiles.push({ path, mtimeMs: Date.now(), sessionID })
  reapTempFiles(cap)
  return path
}

/** 输入：会话；输出：无；预期：删除该会话全部解压临时文件。 */
export function deleteSessionTempFiles(sessionID: string): void {
  for (let index = tempFiles.length - 1; index >= 0; index -= 1) {
    const entry = tempFiles[index]
    if (entry?.sessionID !== sessionID) continue
    try {
      unlinkSync(entry.path)
    } catch {
      // best effort
    }
    tempFiles.splice(index, 1)
  }
}

/** 输入：会话 + 块 + 序号 + base64 + mime + 文件名；输出：媒体临时文件路径。 */
function writeMediaTempFile(
  sessionID: string,
  blockID: string,
  index: number,
  data: string,
  filename: string | undefined,
  cap: number,
): string {
  const safeId = `${blockID}-media-${index.toString()}`.replace(/[^a-zA-Z0-9_-]/g, "-")
  const safeName = (filename ?? "").replace(/[^a-zA-Z0-9._-]/g, "-")
  const suffix = safeName.length > 0 ? `-${safeName}` : ""
  const path = join(tmpdir(), `compressed-context-${safeId}${suffix}-${String(Date.now())}.bin`)
  writeFileSync(path, Buffer.from(data, "base64"), { mode: 0o600 })
  tempFiles.push({ path, mtimeMs: Date.now(), sessionID })
  reapTempFiles(cap)
  return path
}

/** 输入：任意值；输出：可读 JSON 文本；不可序列化时返回空串。 */
function stringifyStored(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    const encoded: unknown = JSON.stringify(value)
    return typeof encoded === "string" ? encoded : ""
  } catch {
    return ""
  }
}

/** 输入：落盘 part + 上下文；输出：可读文本；不可还原的媒体输出占位符。 */
function renderStoredPart(
  part: StoredPart,
  sessionID: string,
  blockID: string,
  index: number,
  cap: number,
): string {
  if (part.type === "text") return part.text ?? ""
  if (part.type === "tool-call") {
    return `[Tool call ${part.name ?? "?"}] ${stringifyStored(part.input)}`
  }
  if (part.type === "tool-result") {
    return `[Tool result ${part.name ?? "?"}] ${stringifyStored(part.result)}`
  }
  const source = part.media?.source
  const filename = part.filename === undefined ? "" : ` "${part.filename}"`
  const mime = source?.mediaType ?? "unknown"
  if (source?.type === "base64" && source.data !== undefined && source.data.length > 0) {
    const path = writeMediaTempFile(sessionID, blockID, index, source.data, part.filename, cap)
    return `[media ${mime}${filename} saved to: ${path}]`
  }
  const kind = source?.type ?? "unknown"
  return `[unavailable media: ${mime}${filename} (${kind} not stored)]`
}

/** 输入：落盘消息 + 上下文；输出：带角色前缀的文本。 */
function renderStoredMessage(
  message: StoredMessage,
  sessionID: string,
  blockID: string,
  messageIndex: number,
  cap: number,
): string {
  const lines: string[] = []
  for (const [partIndex, part] of message.content.entries()) {
    const text = renderStoredPart(
      part,
      sessionID,
      blockID,
      messageIndex * 1000 + partIndex,
      cap,
    )
    if (text.length === 0) continue
    lines.push(message.role === "user" ? `[User]\n${text}` : text)
  }
  return lines.join("\n")
}

/**
 * 输入：storage + 会话 + 块 + 写入口。
 * 输出：无。
 * 预期：逐条读取并立即追加，缺 manifest/消息时写占位符，不把整段原文拼成字符串。
 */
async function appendStoredTranscript(
  storage: StorageLike,
  sessionID: string,
  block: Block,
  cap: number,
  append: (text: string) => void,
): Promise<void> {
  const manifest = await loadTranscriptManifest(storage, sessionID, block.id)
  if (manifest === undefined) {
    append(`[original transcript for ${block.id} is unavailable]`)
    return
  }
  for (let index = 0; index < manifest.count; index += 1) {
    const message = await loadTranscriptMessage(storage, sessionID, block.id, index)
    if (message === undefined) {
      append(`[missing transcript message ${index.toString()} for ${block.id}]`)
      continue
    }
    const text = renderStoredMessage(message, sessionID, block.id, index, cap)
    if (text.length > 0) append(text)
  }
}

/**
 * 输入：工具参数（block 必填，full 可选）+ 会话上下文。
 * 输出：分级结果（内联文本或临时文件路径）。
 * 预期：从磁盘 transcript 按需读取；缺原文/媒体时输出占位符，不报错。
 *       超过内联上限时边读边写临时文件，避免把全文常驻内存。
 */
export async function resolveDecompress(
  args: Record<string, unknown>,
  ctx: { readonly storage: StorageLike },
  sessionID: string,
  limits: DecompressLimits = DEFAULT_LIMITS,
): Promise<DecompressResult> {
  const raw = args["block"]
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { status: "error", message: "block is required (e.g. b3)" }
  }
  const blockId = raw.trim()
  const full = args["full"] === true

  const state = await loadState(ctx.storage, sessionID)
  if (state.blocks.length === 0) {
    return { status: "error", message: `block ${blockId} not found (session has no compressed blocks)` }
  }

  const byId = new Map(state.blocks.map((block) => [block.id, block]))
  const target = byId.get(blockId)
  if (target === undefined) {
    return { status: "error", message: `block ${blockId} not found` }
  }

  const chunks: string[] = []
  let filePath: string | undefined
  let chars = 0
  let tokens = 0
  let first = true

  /** 追加一段文本；超过内联上限后转为临时文件，避免全文常驻内存。 */
  const append = (text: string): void => {
    if (text.length === 0) return
    const separator = first ? "" : "\n\n"
    first = false
    const payload = separator + text
    chars += payload.length
    tokens += countText(payload)
    if (filePath !== undefined) {
      appendFileSync(filePath, payload)
      return
    }
    chunks.push(payload)
    if (chars > limits.inlineMax) {
      filePath = writeTempFile(sessionID, blockId, chunks.join(""), limits.tempCap)
      chunks.length = 0
    }
  }

  const visited = new Set<string>()
  const walk = async (block: Block, depth: number): Promise<void> => {
    if (visited.has(block.id)) return
    visited.add(block.id)
    const sources = block.sourceBlockIds ?? []
    if (sources.length === 0) {
      await appendStoredTranscript(ctx.storage, sessionID, block, limits.tempCap, append)
      return
    }
    if (!full && depth > 0) {
      append(renderBlock(block))
      return
    }
    for (const sourceId of sources) {
      const source = byId.get(sourceId)
      if (source === undefined) continue
      if (!full) {
        append(renderBlock(source))
        continue
      }
      await walk(source, depth + 1)
    }
  }

  await walk(target, 0)
  if (chars === 0) append("(no restorable content for this block)")

  const tokenLabel = limits.showTokens ? ` · ≈${tokens.toString()} tok` : ""
  const header = `[Block ${blockId} content${full ? ", full" : ""}${tokenLabel}]`

  if (filePath !== undefined) {
    return {
      status: "ok",
      inline: `${header}\nContent (${chars.toString()} chars) written to: ${filePath}\nUse the read tool to access it.`,
      path: filePath,
      tokens,
    }
  }
  return { status: "ok", inline: `${header}\n${chunks.join("")}`, tokens }
}
