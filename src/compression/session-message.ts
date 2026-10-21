import type { ContentPartLike, MediaSourceLike, MessageLike } from "./select.ts"

/** 输入：任意值；输出：对象记录或 undefined。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

/** 输入：user.files 项；输出：media part；形状不合法时 undefined。 */
function userFileToPart(value: unknown): ContentPartLike | undefined {
  const file = asRecord(value)
  if (file === undefined || typeof file["mime"] !== "string") return undefined
  const source = asRecord(file["source"])
  const data = typeof file["data"] === "string" ? file["data"] : undefined
  const uri = typeof source?.["uri"] === "string" ? source["uri"] : undefined
  const sourceKind = typeof source?.["type"] === "string" ? source["type"] : "inline"
  const media: MediaSourceLike =
    sourceKind === "uri" && uri !== undefined
      ? { type: "url", url: uri, mediaType: file["mime"] }
      : { type: "base64", ...(data === undefined ? {} : { data }), mediaType: file["mime"] }
  return {
    type: "media",
    ...(typeof file["name"] === "string" ? { filename: file["name"] } : {}),
    media: { source: media },
  }
}

/** 输入：assistant.content 项；输出：可读 parts；reasoning 跳过。 */
function assistantPartToParts(value: unknown): readonly ContentPartLike[] {
  const part = asRecord(value)
  if (part === undefined) return []
  if (part["type"] === "text" && typeof part["text"] === "string") {
    return [{ type: "text", text: part["text"] }]
  }
  if (part["type"] === "tool" && typeof part["name"] === "string") {
    const state = asRecord(part["state"])
    const parts: ContentPartLike[] = [
      {
        type: "tool-call",
        name: part["name"],
        input: state?.["input"],
      },
    ]
    if (state?.["status"] === "completed") {
      parts.push({
        type: "tool-result",
        name: part["name"],
        result: state["content"] ?? state["input"],
      })
    }
    return parts
  }
  if (part["type"] === "media") {
    const media = asRecord(part["media"])
    const source = asRecord(media?.["source"])
    if (source === undefined || typeof source["type"] !== "string") return []
    return [
      {
        type: "media",
        ...(typeof part["filename"] === "string" ? { filename: part["filename"] } : {}),
        media: {
          source: {
            type: source["type"],
            ...(typeof source["data"] === "string" ? { data: source["data"] } : {}),
            ...(source["data"] instanceof Uint8Array ? { data: source["data"] } : {}),
            ...(typeof source["mediaType"] === "string" ? { mediaType: source["mediaType"] } : {}),
            ...(typeof source["url"] === "string" ? { url: source["url"] } : {}),
            ...(typeof source["provider"] === "string" ? { provider: source["provider"] } : {}),
            ...(typeof source["id"] === "string" ? { id: source["id"] } : {}),
            ...(typeof source["expiresAt"] === "number" ? { expiresAt: source["expiresAt"] } : {}),
          },
        },
      },
    ]
  }
  return []
}

/**
 * 输入：ctx.session.context 返回的持久化 session 消息。
 * 输出：MessageLike 列表；user.text 转 text，user.files 转 media，assistant.content 转 parts。
 * 预期：agent/model/compaction 等非对话项跳过；reasoning 不进入压缩 transcript。
 */
export function sessionMessagesToMessageLikes(messages: readonly unknown[]): readonly MessageLike[] {
  const out: MessageLike[] = []
  for (const item of messages) {
    const record = asRecord(item)
    if (record === undefined) continue
    const id = typeof record["id"] === "string" ? record["id"] : undefined
    if (record["type"] === "user") {
      const content: ContentPartLike[] = []
      if (typeof record["text"] === "string" && record["text"].length > 0) {
        content.push({ type: "text", text: record["text"] })
      }
      if (Array.isArray(record["files"])) {
        for (const file of record["files"]) {
          const part = userFileToPart(file)
          if (part !== undefined) content.push(part)
        }
      }
      out.push({ ...(id === undefined ? {} : { id }), role: "user", content })
      continue
    }
    if (record["type"] === "assistant" && Array.isArray(record["content"])) {
      const content: ContentPartLike[] = []
      for (const part of record["content"]) {
        content.push(...assistantPartToParts(part))
      }
      out.push({ ...(id === undefined ? {} : { id }), role: "assistant", content })
    }
  }
  return out
}
