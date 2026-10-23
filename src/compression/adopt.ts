import type { Plugin } from "@opencode/plugin"

import { createT1Block } from "./block.ts"
import { isCompactionInFlight } from "./inflight.ts"
import { toMarkdownSummary } from "./markdown.ts"
import { isCheckpoint, messageText, type MessageLike } from "./select.ts"
import { stateStore } from "./state-store.ts"

/** 原生 checkpoint 里抽出的摘要与 recent 上下文。 */
export interface NativeCheckpoint {
  readonly summary: string
  readonly recent?: string
}

/**
 * 输入：OpenCode checkpoint 文本。
 * 输出：`<summary>` / `<recent-context>` 内容；不是 checkpoint 时 undefined。
 * 预期：只做只读解析，不改原文。
 */
export function extractCheckpoint(text: string): NativeCheckpoint | undefined {
  if (!text.trimStart().startsWith("<conversation-checkpoint>")) return undefined
  const summary = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(text)?.[1]?.trim()
  if (summary === undefined || summary.length === 0) return undefined
  const recent = /<recent-context>\n?([\s\S]*?)\n?<\/recent-context>/.exec(text)?.[1]?.trim()
  return recent === undefined || recent.length === 0 ? { summary } : { summary, recent }
}

/**
 * 输入：插件上下文 + sessionID + 当前请求消息。
 * 输出：是否收养了原生摘要。
 * 预期：仅当插件还没有任何块时，把 OpenCode 自己的 checkpoint 摘要当作 b1:T1；
 *       它没有原始 transcript，fromId/toId 指向 checkpoint 消息本身。
 */
export async function adoptNativeCheckpoint(
  ctx: Plugin.Context,
  sessionID: string,
  messages: readonly MessageLike[],
): Promise<boolean> {
  // 压缩期间只允许 compaction 钩子写 state；收养原生 checkpoint 也要让路。
  if (isCompactionInFlight(sessionID)) return false

  const checkpoint = messages.findLast((message) => isCheckpoint(message))
  if (checkpoint === undefined) return false
  const parsed = extractCheckpoint(messageText(checkpoint))
  if (parsed === undefined) return false

  const summary = toMarkdownSummary(parsed.summary)
  return stateStore(ctx.storage).transact(sessionID, (state) => {
    if (state.blocks.length > 0 || state.pending !== undefined || state.terminal !== undefined) {
      return { result: false }
    }
    const block = createT1Block({
      blocks: [],
      summary,
      // 原生摘要没有原始 transcript；空范围让 decompress full 返回 unavailable，而不是伪造原文。
      fromId: "",
      toId: "",
      sourceChars: parsed.summary.length,
    })
    return { next: { blocks: [block], attempts: 0 }, result: true }
  })
}
