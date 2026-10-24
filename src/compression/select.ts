import { CHECKPOINT_PREFIX, stringify, toolInput, toolResult, toolResultText } from "../shared/parts.ts"

/** 媒体 source 的最小结构；bytes/base64 可落盘，url/ref 只保留引用。 */
export interface MediaSourceLike {
  readonly type: string
  readonly data?: string | Uint8Array | undefined
  readonly mediaType?: string | undefined
  readonly url?: string | undefined
  readonly provider?: string | undefined
  readonly id?: string | undefined
  readonly expiresAt?: number | undefined
}

/** 单条内容 part 的最小结构，避免绑定 @opencode/ai 的具体类。 */
export interface ContentPartLike {
  readonly type: string
  readonly text?: string | null | undefined
  readonly name?: string | undefined
  readonly input?: unknown
  readonly result?: unknown
  readonly state?:
    | {
        readonly input?: unknown
        readonly content?: unknown
        readonly output?: unknown
      }
    | undefined
  readonly filename?: string | undefined
  readonly media?:
    | {
        readonly source?: MediaSourceLike | undefined
        readonly mediaType?: string | undefined
        readonly info?:
          | {
              readonly width?: number | undefined
              readonly height?: number | undefined
              readonly durationSeconds?: number | undefined
            }
          | undefined
        readonly providerMetadata?: unknown
      }
    | undefined
}

/** 单条消息的最小结构。 */
export interface MessageLike {
  readonly id?: string | undefined
  readonly role: string
  readonly content: readonly ContentPartLike[]
  /** v2 用户消息把正文放在 text，而不是 content 数组。 */
  readonly text?: string | null | undefined
}

/** 输入：消息；输出：纯文本（只拼 text part）。 */
export function messageText(message: MessageLike): string {
  const direct = typeof message.text === "string" ? message.text : ""
  const content: readonly ContentPartLike[] = Array.isArray(message.content)
    ? message.content
    : []
  const parts = content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
  return [direct, parts].filter((text) => text.length > 0).join("\n")
}

/** 输入：消息；输出：是否是 checkpoint 消息。 */
export function isCheckpoint(message: MessageLike): boolean {
  return messageText(message).trimStart().startsWith(CHECKPOINT_PREFIX)
}

/**
 * 输入：当前请求的消息列表。
 * 输出：可压缩的消息（最后一条 user 之前，排除 checkpoint）。
 * 预期：没有 user 消息时返回空数组。
 */
export function eligibleMessages(messages: readonly MessageLike[]): readonly MessageLike[] {
  const lastUser = messages.findLastIndex((message) => message.role === "user")
  if (lastUser <= 0) return []
  return messages.slice(0, lastUser).filter((message) => !isCheckpoint(message))
}

/**
 * 输入：compaction 钩子的 older 消息。
 * 输出：可压缩消息（排除 checkpoint）。
 * 预期：older 里没有“当前 user”可排除，不能复用 eligibleMessages。
 */
export function olderMessages(messages: readonly MessageLike[]): readonly MessageLike[] {
  return messages.filter((message) => !isCheckpoint(message))
}

/** 输入：消息列表；输出：首尾带 id 的消息 id；没有可用 id 时返回 undefined。 */
export function messageRange(
  messages: readonly MessageLike[],
): { readonly fromId: string; readonly toId: string } | undefined {
  const first = messages.find((message) => message.id !== undefined)
  const last = [...messages].reverse().find((message) => message.id !== undefined)
  if (first?.id === undefined || last?.id === undefined) return undefined
  return { fromId: first.id, toId: last.id }
}

/** 输入：消息列表；输出：所有 text part 的总字符数。 */
export function textChars(messages: readonly MessageLike[]): number {
  let total = 0
  for (const message of messages) {
    if (typeof message.text === "string") total += message.text.length
    const content: readonly ContentPartLike[] = Array.isArray(message.content)
      ? message.content
      : []
    for (const part of content) {
      if (part.type === "text") {
        total += (part.text ?? "").length
        continue
      }
      if (part.type === "tool" || part.type === "tool-call" || part.type === "tool-result") {
        total += `${stringify(toolInput(part))}${toolResultText(toolResult(part))}`.length
      }
    }
  }
  return total
}
