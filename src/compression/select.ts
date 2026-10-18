/** 单条内容 part 的最小结构，避免绑定 @opencode/ai 的具体类。 */
export interface ContentPartLike {
  readonly type: string
  readonly text?: string | null | undefined
  readonly name?: string | undefined
  readonly input?: unknown
  readonly result?: unknown
  readonly media?: { readonly mediaType?: string | undefined } | undefined
}

/** 单条消息的最小结构。 */
export interface MessageLike {
  readonly id?: string | undefined
  readonly role: string
  readonly content: readonly ContentPartLike[]
}

export const CHECKPOINT_PREFIX = "<conversation-checkpoint>"

/** 输入：消息；输出：纯文本（只拼 text part）。 */
export function messageText(message: MessageLike): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
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

/** 输入：消息列表；输出：所有 text part 的总字符数。 */
export function textChars(messages: readonly MessageLike[]): number {
  let total = 0
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "text") total += (part.text ?? "").length
    }
  }
  return total
}
