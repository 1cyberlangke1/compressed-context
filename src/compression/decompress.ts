/**
 * 解压：把已压缩块的内容还给模型。
 *
 * - `full:false`（默认）展开一层：合并块返回直接子块的摘要；T1 块返回原文。
 * - `full:true` 递归到 T1，原文从 OpenCode 数据库只读直查（见 history.ts）。
 * - 返回分级：≤ INLINE_MAX 字符内联进 tool result；超出写 `os.tmpdir()` 文件并回路径，
 *   模型用 read 工具打开。临时文件有 reaper（上限 TEMP_CAP，删最老），防无限堆积。
 * - copy-paste 语义：不修改任何块状态；块保持折叠，内容只是 tool result 文本。
 */

import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { countText } from "../tokens.ts"
import type { Block, StorageLike } from "./state.ts"
import { loadState } from "./state.ts"
import { renderBlock } from "./render.ts"
import {
  messageRowToText,
  openHistoryDb,
  readSessionRows,
  resolveDatabasePath,
  rowsInRange,
  type HistoryDb,
} from "./history.ts"

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

/** 一次解压收集的文本。 */
export interface CollectedContent {
  readonly text: string
  /** 块是否存在（状态里找得到）。内容缺失但块存在也算 found。 */
  readonly found: boolean
}

export interface CollectInput {
  /** 全部块（含被折叠的）——解压按 id 直查，不看 active 链。 */
  readonly blocks: readonly Block[]
  /** T1 块 id → 原文 transcript。缺项时从数据库直查（见 history.ts）。 */
  readonly transcripts: ReadonlyMap<string, string>
}

/** 解压工具结果；ok 时 inline 或 path 至少一项存在。 */
export type DecompressResult =
  | { readonly status: "ok"; readonly inline: string; readonly path?: string; readonly tokens?: number }
  | { readonly status: "error"; readonly message: string }

const tempFiles: { path: string; mtimeMs: number }[] = []

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

/** 输入：块 id + 正文 + 上限；输出：临时文件路径。预期：文件名含 id 和时间戳，永不互相覆盖。 */
function writeTempFile(blockId: string, body: string, cap: number): string {
  const safeId = blockId.replace(/[^a-zA-Z0-9_-]/g, "-")
  const path = join(tmpdir(), `compressed-context-decompress-${safeId}-${String(Date.now())}.txt`)
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 })
  tempFiles.push({ path, mtimeMs: Date.now() })
  reapTempFiles(cap)
  return path
}

/**
 * 输入：收集输入 + 目标块 id + full 开关。
 * 输出：块内容文本；found 表示块在状态里存在。
 * 预期：full=false 只展开一层（合并块→子块摘要，T1→原文）；full=true 递归到全部 T1 原文。
 *       循环引用用 visited 集合防挂死。
 */
export function collectBlockContent(
  input: CollectInput,
  blockId: string,
  full: boolean,
): CollectedContent {
  const byId = new Map(input.blocks.map((block) => [block.id, block]))
  const target = byId.get(blockId)
  if (target === undefined) return { text: "", found: false }

  const transcripts = new Map(input.transcripts)
  const visited = new Set<string>()

  /** 递归收集；full=false 时只展开一层，合并块直接拼子块摘要。 */
  const walk = (block: Block, depth: number): string[] => {
    if (visited.has(block.id)) return []
    visited.add(block.id)
    const sources = block.sourceBlockIds ?? []
    if (sources.length === 0) {
      // T1（或旧版无 sourceBlockIds 的块）：取原文
      const transcript = transcripts.get(block.id)
      return transcript === undefined ? [] : [transcript]
    }
    if (!full && depth > 0) {
      return [renderBlock(block)]
    }
    const parts: string[] = []
    for (const sourceId of sources) {
      const source = byId.get(sourceId)
      if (source === undefined) continue
      if (!full) {
        parts.push(renderBlock(source))
        continue
      }
      parts.push(...walk(source, depth + 1))
    }
    return parts
  }

  return { text: walk(target, 0).join("\n\n"), found: true }
}

/**
 * 输入：块 id；输出：从数据库直查的该块原文；缺失返回 undefined。
 * 预期：DB 路径解析失败/表结构不符/文件不存在时返回 undefined（解压降级为"无原文"），
 *       绝不抛错——解压失败不该炸会话。只读连接，不写 WAL，不影响正在写的 server。
 */
export function readTranscriptFromDb(sessionID: string, fromId: string, toId: string): string | undefined {
  try {
    const envDb = process.env["OPENCODE_DB"]
    const dataDir = process.env["OPENCODE_DATA_DIR"] ?? ""
    const path = resolveDatabasePath(dataDir, envDb)
    const db: HistoryDb = openHistoryDb(path)
    try {
      const rows = readSessionRows(db, sessionID)
      const inRange = rowsInRange(rows, fromId, toId)
      const parts = inRange.map(messageRowToText).filter((text) => text.length > 0)
      return parts.length > 0 ? parts.join("\n\n") : undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/**
 * 输入：工具参数（block 必填，full 可选）+ 会话上下文。
 * 输出：分级结果（内联文本或临时文件路径）。
 * 预期：块不存在 / 缺参数返回 status:"error"；不修改块状态。
 *       full=true 时 T1 原文优先查 DB；查不到降级为"无该块原文"的说明，不报错。
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

  // 递归收集 T1 叶子；缺 transcript 的 T1 从 DB 直查补齐。
  const byId = new Map(state.blocks.map((block) => [block.id, block]))
  const target = byId.get(blockId)
  if (target === undefined) {
    return { status: "error", message: `block ${blockId} not found` }
  }

  const parts: string[] = []
  const visited = new Set<string>()
  const dbTranscripts = new Map<string, string>()
  let dbFailed = false

  const walk = (block: Block, depth: number): void => {
    if (visited.has(block.id)) return
    visited.add(block.id)
    const sources = block.sourceBlockIds ?? []
    if (sources.length === 0) {
      const fromDb = dbTranscripts.get(block.id)
      if (fromDb !== undefined) {
        parts.push(fromDb)
        return
      }
      if (!dbFailed) {
        const transcript = readTranscriptFromDb(sessionID, block.fromId, block.toId)
        if (transcript !== undefined) {
          dbTranscripts.set(block.id, transcript)
          parts.push(transcript)
          return
        }
        dbFailed = true
      }
      parts.push(`[original transcript for ${block.id} is unavailable]`)
      return
    }
    if (!full && depth > 0) {
      parts.push(renderBlock(block))
      return
    }
    for (const sourceId of sources) {
      const source = byId.get(sourceId)
      if (source === undefined) continue
      if (!full) {
        parts.push(renderBlock(source))
        continue
      }
      walk(source, depth + 1)
    }
  }

  walk(target, 0)
  const body = parts.length > 0 ? parts.join("\n\n") : "(no restorable content for this block)"
  const tokens = countText(body)
  const tokenLabel = limits.showTokens ? ` · ≈${tokens.toString()} tok` : ""
  const header = `[Block ${blockId} content${full ? ", full" : ""}${tokenLabel}]`

  if (body.length > limits.inlineMax) {
    const path = writeTempFile(blockId, body, limits.tempCap)
    return {
      status: "ok",
      inline: `${header}\nContent (${body.length.toString()} chars) written to: ${path}\nUse the read tool to access it.`,
      path,
      tokens,
    }
  }
  return { status: "ok", inline: `${header}\n${body}`, tokens }
}
