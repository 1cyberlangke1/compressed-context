/**
 * 只读直查 OpenCode 的 `opencode.db`（`session_message` 表）拿历史原文。
 *
 * 插件 ctx 没有暴露读 checkpoint 之前消息的接口；数据库就在同进程的文件系统上，
 * 只读打开是最直接且无第二份存储的路。表结构锁在 2.0.32（peerDep），升级时需核对。
 */

import { join } from "node:path"

/** `session_message` 表行的形状（只取我们关心的列）。 */
export interface SessionMessageRow {
  readonly id: string
  readonly session_id: string
  readonly type: string
  readonly seq: number
  readonly data: string
}

/** 解析后的最小消息视图；parts 与插件 MessageLike 的 content 兼容。 */
export interface ParsedHistoryMessage {
  readonly id: string
  readonly role: string
  readonly parts: {
    readonly type: string
    readonly text?: string
    readonly name?: string
    readonly input?: unknown
    readonly result?: unknown
  }[]
}

/** `session_message.type` 里代表原文的类型；其余（compaction/idle/system 等）跳过。 */
const CONTENT_TYPES = new Set(["user", "assistant"])

/** 输入：表行；输出：解析后的消息；预期：非原文类型或坏 JSON 返回 undefined，绝不抛错。 */
export function parseMessageData(row: SessionMessageRow): ParsedHistoryMessage | undefined {
  if (!CONTENT_TYPES.has(row.type)) return undefined
  let value: unknown
  try {
    value = JSON.parse(row.data)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const content = record["content"]
  if (row.type === "user") {
    const text = typeof record["text"] === "string" ? record["text"] : ""
    return {
      id: row.id,
      role: "user",
      parts: text.length > 0 ? [{ type: "text", text }] : [],
    }
  }
  if (!Array.isArray(content)) return undefined
  const parts: ParsedHistoryMessage["parts"] = []
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue
    const typed = part as Record<string, unknown>
    const type = typeof typed["type"] === "string" ? typed["type"] : ""
    if (type === "text" && typeof typed["text"] === "string") {
      parts.push({ type: "text", text: typed["text"] })
      continue
    }
    if (type === "tool-call" || type === "tool-result") {
      const name = typeof typed["name"] === "string" ? typed["name"] : ""
      parts.push({
        type,
        name,
        ...(type === "tool-call" ? { input: typed["input"] } : { result: typed["result"] }),
      })
    }
    // reasoning / media 等其余 part 不进 transcript
  }
  return { id: row.id, role: "assistant", parts }
}

/** 输入：表行；输出：transcript 文本行；预期：非原文类型输出空串。 */
export function messageRowToText(row: SessionMessageRow): string {
  const parsed = parseMessageData(row)
  if (parsed === undefined) return ""
  const lines: string[] = []
  for (const part of parsed.parts) {
    if (part.type === "text") {
      lines.push(parsed.role === "user" ? `[User]\n${part.text ?? ""}` : (part.text ?? ""))
      continue
    }
    if (part.type === "tool-call") {
      lines.push(`[Tool call ${part.name ?? "?"}] ${JSON.stringify(part.input ?? "")}`)
      continue
    }
    if (part.type === "tool-result") {
      lines.push(`[Tool result ${part.name ?? "?"}] ${JSON.stringify(part.result ?? "")}`)
    }
  }
  return lines.join("\n")
}

/**
 * 输入：按 seq 升序的行 + 范围两端的 id（含）。
 * 输出：范围内的原文行（按 seq 升序，跳过非原文类型）。
 * 预期：任一端 id 不在行里时返回空数组——块的 fromId/toId 一定存在，缺失说明历史被清过。
 */
export function rowsInRange(
  rows: readonly SessionMessageRow[],
  fromId: string,
  toId: string,
): readonly SessionMessageRow[] {
  const from = rows.find((row) => row.id === fromId)
  const to = rows.find((row) => row.id === toId)
  if (from === undefined || to === undefined) return []
  const [start, end] = from.seq <= to.seq ? [from.seq, to.seq] : [to.seq, from.seq]
  return rows.filter((row) => row.seq >= start && row.seq <= end && CONTENT_TYPES.has(row.type))
}

/**
 * 输入：data 目录（OpenCode 的 Global.data）+ 可选的 `OPENCODE_DB` 值。
 * 输出：opencode.db 的绝对路径。
 * 预期：env 优先（E2E 隔离即靠它）；无 env 时 data 目录 + opencode.db（latest/dev/beta/next/prod
 *       channel 或 OPENCODE_DISABLE_CHANNEL_DB 时无 channel 后缀；其余 channel 带，此处不复刻
 *       channel 逻辑——插件拿不到 channel，env 缺省时 latest 命名覆盖主流程）。
 */
export function resolveDatabasePath(dataDir: string, envDb: string | undefined): string {
  if (envDb !== undefined && envDb !== "") return envDb
  return join(dataDir, "opencode.db")
}

/**
 * 只读打开 OpenCode 数据库。
 * 输入：DB 文件路径。
 * 输出：`node:sqlite` DatabaseSync（readonly 模式）。
 * 预期：路径不存在时抛错；调用方持有句柄并负责 close。
 * 备注：与 server 同进程同文件，只读连接不写 WAL，不影响正在写的 server。
 *       node:sqlite 在 Node 22.5+ 可用；OpenCode 的 node 构建即此驱动（core 的 sqlite.node.ts）。
 */
/**
 * 只读打开 OpenCode 数据库。
 * 输入：DB 文件路径。
 * 输出：`node:sqlite` DatabaseSync（readOnly 模式）。
 * 预期：路径不存在时抛错；调用方持有句柄并负责 close。
 * 备注：与 server 同进程同文件，只读连接不写 WAL，不影响正在写的 server。
 *       node:sqlite 在 Node 22.5+ 可用（OpenCode 的 node 构建即此驱动，core 的 sqlite.node.ts）。
 *       require 是唯一能在 CommonJS/ESM 双构下同步拿到 node:sqlite 的方式；ESM 顶层也可用静态 import，
 *       但该模块标记 experimental 且部分打包器会尝试解析——保持运行时 require 与 core 的按 runtime 分流一致。
 */
export function openHistoryDb(path: string): HistoryDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ESM 下同步取 node:sqlite 的唯一方式；@types/node 的 DatabaseSync 类型已覆盖返回形状。
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => HistoryDb }
  return new DatabaseSync(path, { readOnly: true })
}

/** 打开的只读数据库句柄的最小形状（node:sqlite DatabaseSync 的子集）。 */
export interface HistoryDb {
  prepare(sql: string): {
    all(...params: readonly unknown[]): unknown[]
    run(...params: readonly unknown[]): { changes: number | bigint }
  }
  close(): void
}

/**
 * 输入：已打开的只读 DB + sessionID。
 * 输出：该会话全部消息行，按 seq 升序（含非原文类型，解码交给 parseMessageData）。
 * 预期：不做 checkpoint 过滤——块的 fromId/toId 落在 checkpoint 之前，必须取全量。
 */
export function readSessionRows(db: HistoryDb, sessionID: string): readonly SessionMessageRow[] {
  return db
    .prepare("select id, session_id, type, seq, data from session_message where session_id = ? order by seq asc")
    .all(sessionID) as unknown as readonly SessionMessageRow[]
}
