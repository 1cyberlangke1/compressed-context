/**
 * OpenCode 消息 part 的兼容层。
 *
 * OpenCode v2 的工具 part 是 `type: "tool"`，输入/输出在 `state.input` /
 * `state.content`；旧测试和部分 provider 仍用 `tool-call` / `tool-result`。
 * 这里只做形状归一，避免 tokens / transcript / select 各自漏一种形状。
 */

/** 工具 part 的 state；只保留计数和转录需要的字段。 */
export interface ToolStateLike {
  readonly input?: unknown
  readonly content?: unknown
  readonly output?: unknown
}

/** 工具 part 的最小形状。 */
export interface ToolPartLike {
  readonly name?: string | undefined
  readonly input?: unknown
  readonly result?: unknown
  readonly state?: ToolStateLike | undefined
}

/** 输入：任意值；输出：可计数文本；不可序列化时返回空串。 */
export function stringify(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    const encoded: unknown = JSON.stringify(value)
    return typeof encoded === "string" ? encoded : ""
  } catch {
    return ""
  }
}

/** 输入：工具 part；输出：工具调用参数。 */
export function toolInput(part: ToolPartLike): unknown {
  return part.input ?? part.state?.input
}

/** 输入：工具 part；输出：工具结果。 */
export function toolResult(part: ToolPartLike): unknown {
  return part.result ?? part.state?.content ?? part.state?.output
}

/**
 * 输入：工具结果（v2 state.content 数组、字符串、对象或旧 result.value）。
 * 输出：可读文本；数组只拼 text 项，其余项退回 JSON。
 * 预期：不丢工具输出，同时避免把媒体 base64 当普通文本展开。
 */
export function toolResultText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          const record = item as { readonly type?: unknown; readonly text?: unknown }
          if (record.type === "text" && typeof record.text === "string") return record.text
        }
        return stringify(item)
      })
      .filter((text) => text.length > 0)
      .join("\n")
  }
  if (typeof value === "object" && value !== null) {
    const record = value as { readonly content?: unknown; readonly output?: unknown; readonly value?: unknown }
    if (record.content !== undefined) return toolResultText(record.content)
    if (record.output !== undefined) return toolResultText(record.output)
    if (record.value !== undefined) return toolResultText(record.value)
  }
  return stringify(value)
}
