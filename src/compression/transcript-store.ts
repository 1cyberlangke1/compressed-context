import type { Schema } from "effect"

import { isSessionDeleted } from "./deleted-sessions.ts"
import type { Block, StorageLike } from "./state.ts"
import type { MediaSourceLike, MessageLike } from "./select.ts"

/** 落盘的媒体 source：bytes 统一转 base64；url/ref 只存引用。 */
export interface StoredMediaSource {
  readonly type: "base64" | "url" | "ref" | "unknown"
  readonly data?: string
  readonly mediaType?: string
  readonly url?: string
  readonly provider?: string
  readonly id?: string
  readonly expiresAt?: number
}

/** 落盘的单条 part；reasoning 不进入这里。 */
export interface StoredPart {
  readonly type: "text" | "tool-call" | "tool-result" | "media"
  readonly text?: string
  readonly name?: string
  readonly input?: unknown
  readonly result?: unknown
  readonly filename?: string
  readonly media?: {
    readonly source: StoredMediaSource
    readonly info?: unknown
  }
}

/** 落盘的单条消息。 */
export interface StoredMessage {
  readonly id?: string
  readonly role: string
  readonly content: readonly StoredPart[]
}

/** 一个 T1 块的 transcript manifest；消息本体按 msg:<index> 分开存。 */
export interface TranscriptManifest {
  readonly v: 1
  readonly sessionID: string
  readonly blockID: string
  readonly fromId: string
  readonly toId: string
  readonly count: number
  readonly createdAt: number
}

const PREFIX = "compression:transcript:"

/** 输入：sessionID；输出：该会话全部 transcript key 的公共前缀。 */
export function transcriptSessionPrefix(sessionID: string): string {
  return `${PREFIX}${sessionID}:`
}

/** 输入：sessionID + blockID；输出：manifest key。 */
export function transcriptManifestKey(sessionID: string, blockID: string): string {
  return `${transcriptSessionPrefix(sessionID)}${blockID}:manifest`
}

/** 输入：sessionID + blockID + 序号；输出：单条消息 key。 */
export function transcriptMessageKey(sessionID: string, blockID: string, index: number): string {
  return `${transcriptSessionPrefix(sessionID)}${blockID}:msg:${index.toString()}`
}

/** 输入：任意数据；输出：是否 Uint8Array。 */
function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

/** 输入：media source；输出：可 JSON 化的 source；未知形状保留 unknown。 */
function storeSource(source: MediaSourceLike | undefined): StoredMediaSource {
  if (source === undefined) return { type: "unknown" }
  if (source.type === "bytes") {
    const data = isBytes(source.data)
      ? Buffer.from(source.data).toString("base64")
      : typeof source.data === "string"
        ? source.data
        : ""
    return {
      type: "base64",
      ...(data.length === 0 ? {} : { data }),
      ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
    }
  }
  if (source.type === "base64") {
    return {
      type: "base64",
      ...(typeof source.data === "string" ? { data: source.data } : {}),
      ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
    }
  }
  if (source.type === "url") {
    return {
      type: "url",
      ...(source.url === undefined ? {} : { url: source.url }),
      ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
      ...(source.expiresAt === undefined ? {} : { expiresAt: source.expiresAt }),
    }
  }
  if (source.type === "ref") {
    return {
      type: "ref",
      ...(source.provider === undefined ? {} : { provider: source.provider }),
      ...(source.id === undefined ? {} : { id: source.id }),
      ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
    }
  }
  return { type: "unknown", ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }) }
}

/** 输入：可压缩消息；输出：落盘消息；预期：跳过 reasoning 和其他未知 part。 */
export function toStoredMessage(message: MessageLike): StoredMessage {
  const content: StoredPart[] = []
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "tool-call") {
      content.push({
        type: "tool-call",
        ...(part.name === undefined ? {} : { name: part.name }),
        input: part.input,
      })
      continue
    }
    if (part.type === "tool-result") {
      content.push({
        type: "tool-result",
        ...(part.name === undefined ? {} : { name: part.name }),
        result: part.result,
      })
      continue
    }
    if (part.type === "media") {
      content.push({
        type: "media",
        ...(part.filename === undefined ? {} : { filename: part.filename }),
        media: {
          source: storeSource(part.media?.source),
          ...(part.media?.info === undefined ? {} : { info: part.media.info }),
        },
      })
    }
  }
  return {
    ...(message.id === undefined ? {} : { id: message.id }),
    role: message.role,
    content,
  }
}

/**
 * 输入：storage + 会话 + T1 块 + 覆盖的消息。
 * 输出：无。
 * 预期：先写 manifest，再逐条写消息；删除墓碑存在时整体跳过。
 */
export async function saveTranscript(
  storage: StorageLike,
  sessionID: string,
  block: Pick<Block, "id" | "fromId" | "toId">,
  messages: readonly MessageLike[],
): Promise<void> {
  if (isSessionDeleted(sessionID)) return
  const manifest: TranscriptManifest = {
    v: 1,
    sessionID,
    blockID: block.id,
    fromId: block.fromId,
    toId: block.toId,
    count: messages.length,
    createdAt: Date.now(),
  }
  await storage.set(transcriptManifestKey(sessionID, block.id), manifest as unknown as Schema.Json)
  for (const [index, message] of messages.entries()) {
    await storage.set(
      transcriptMessageKey(sessionID, block.id, index),
      toStoredMessage(message) as unknown as Schema.Json,
    )
  }
}

/** 输入：storage + 会话 + 块；输出：合法 manifest 或 undefined。 */
export async function loadTranscriptManifest(
  storage: StorageLike,
  sessionID: string,
  blockID: string,
): Promise<TranscriptManifest | undefined> {
  const raw = await storage.get(transcriptManifestKey(sessionID, blockID))
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (
    record["v"] !== 1 ||
    typeof record["sessionID"] !== "string" ||
    typeof record["blockID"] !== "string" ||
    typeof record["fromId"] !== "string" ||
    typeof record["toId"] !== "string" ||
    typeof record["count"] !== "number" ||
    !Number.isInteger(record["count"]) ||
    record["count"] < 0
  ) {
    return undefined
  }
  return {
    v: 1,
    sessionID: record["sessionID"],
    blockID: record["blockID"],
    fromId: record["fromId"],
    toId: record["toId"],
    count: record["count"],
    createdAt: typeof record["createdAt"] === "number" ? record["createdAt"] : 0,
  }
}

/** 输入：storage + 会话 + 块 + 序号；输出：落盘消息或 undefined。 */
export async function loadTranscriptMessage(
  storage: StorageLike,
  sessionID: string,
  blockID: string,
  index: number,
): Promise<StoredMessage | undefined> {
  const raw = await storage.get(transcriptMessageKey(sessionID, blockID, index))
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record["role"] !== "string" || !Array.isArray(record["content"])) return undefined
  return {
    ...(typeof record["id"] === "string" ? { id: record["id"] } : {}),
    role: record["role"],
    content: record["content"] as StoredPart[],
  }
}

/** 输入：storage + 会话；输出：无；预期：删掉该会话所有 manifest/message key。 */
export async function deleteTranscriptsForSession(
  storage: StorageLike & {
    scan?: (options: { prefix: string; limit: number; after?: string }) => Promise<{
      entries: readonly { key: string; value: unknown }[]
      next?: string
    }>
  },
  sessionID: string,
): Promise<void> {
  if (storage.scan === undefined) return
  const prefix = transcriptSessionPrefix(sessionID)
  let after: string | undefined
  for (;;) {
    const page = await storage.scan({
      prefix,
      limit: 100,
      ...(after === undefined ? {} : { after }),
    })
    for (const entry of page.entries) await storage.remove(entry.key)
    if (page.next === undefined) return
    after = page.next
  }
}

/** 输入：storage + 会话 + 块；输出：manifest 是否存在。 */
export async function hasTranscript(
  storage: StorageLike,
  sessionID: string,
  blockID: string,
): Promise<boolean> {
  return (await loadTranscriptManifest(storage, sessionID, blockID)) !== undefined
}
