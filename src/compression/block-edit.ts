import { countText } from "../shared/tokens.ts"
import type { EditBlockErrorCode } from "../shared/rpc.ts"
import { toBabelSummary } from "./babel.ts"
import { toMarkdownSummary } from "./markdown.ts"
import { renderAll, type RenderOptions } from "./render.ts"
import { isBabelSummary, isMarkdownSummary, type Summary } from "./schema.ts"
import { sourceIdsOf, type Block, type State } from "./state.ts"
import { summaryBody, summaryChars } from "./summary.ts"
import { validateSummary } from "./validate.ts"

/**
 * 编辑失败的原因码（定义在 shared/rpc.ts，服务端与 TUI 共用）。
 * 服务端不返回任何人类可读文案：文案属于界面，由 TUI 按当前语言渲染。
 * `a` / `b` 是文案里要插的数字（都是十进制字符串）。
 */

/** 一次块编辑请求；所有限制都由调用方（服务端）按当前模型窗口算好再传进来。 */
export interface EditBlockRequest {
  readonly state: State
  readonly blockID: string
  /** 乐观并发令牌：TUI 打开编辑器时看到的 `Block.at`。 */
  readonly expectedAt: number
  /** 用户改完的完整正文（含首行头）。 */
  readonly text: string
  /** 单块字符上限，来自 resolveSummaryLimits(...).blockChars。 */
  readonly blockChars: number
  /** 整条 active 链的 token 预算，来自 resolveSummaryLimits(...).budgetTokens。 */
  readonly totalChars: number
  readonly render: RenderOptions
}

/** 输入：编辑请求；输出：新状态或拒绝原因码。 */
export type EditBlockOutcome =
  | { readonly ok: true; readonly state: State }
  | {
      readonly ok: false
      readonly code: EditBlockErrorCode
      readonly a?: string
      readonly b?: string
    }

/**
 * 输入：当前状态 + 编辑请求。
 * 输出：替换掉目标块正文后的新状态，或拒绝原因码。
 * 预期：只改 summary 与 summaryTokens；tier/height/order/fromId/toId/sourceTokens 拓扑一律不动。
 */
export function editBlock(request: EditBlockRequest): EditBlockOutcome {
  if (request.state.pending !== undefined) return { ok: false, code: "compacting" }
  if (request.text.includes("\u0000")) return { ok: false, code: "nul" }

  const index = request.state.blocks.findIndex((block) => block.id === request.blockID)
  const block = request.state.blocks[index]
  if (block === undefined) return { ok: false, code: "notFound" }
  // 被合并掉的源块不在 active 链里，改它没有任何意义。
  if (isConsumed(request.state.blocks, block.id)) return { ok: false, code: "merged" }
  if (block.at !== request.expectedAt) return { ok: false, code: "stale" }

  const summary = rebuildSummary(block, request.text)
  if (summary === "legacyJson" || summary === "badHeader") return { ok: false, code: summary }

  const validation = validateSummary(summary, 0, 0, request.blockChars)
  if (!validation.ok) {
    // 字段为空 → 标题/目标/正文不合法；"summary" 这一个字段失败时只剩「太长」。
    if (!validation.fields.includes("summary")) return { ok: false, code: "badHeader" }
    return {
      ok: false,
      code: "tooLong",
      a: String(summaryChars(summary)),
      b: String(request.blockChars),
    }
  }

  const summaryTokens = Math.max(1, countText(summaryBody(summary)))
  if (summaryTokens >= block.sourceTokens) {
    return {
      ok: false,
      code: "notSmaller",
      a: String(summaryTokens),
      b: String(block.sourceTokens),
    }
  }

  const nextBlock: Block = { ...block, summary, summaryTokens }
  const blocks = request.state.blocks.map((item, at) => (at === index ? nextBlock : item))
  const chainTokens = countText(renderAll(blocks, request.state.pending, request.render))
  if (chainTokens > request.totalChars) {
    return { ok: false, code: "chainBudget", a: String(chainTokens), b: String(request.totalChars) }
  }

  return { ok: true, state: { ...request.state, blocks } }
}

/** 输入：块列表 + 目标 id；输出：该块是否已被别的块合并。 */
function isConsumed(blocks: readonly Block[], id: string): boolean {
  return blocks.some((block) => sourceIdsOf(block).includes(id))
}

/**
 * 输入：块 + 用户文本。
 * 输出：同格式的新摘要，或错误码。
 * 预期：Babel 必须能从 `T=...|G=...` 解析出标题与目标；旧 JSON 块不提供编辑。
 */
function rebuildSummary(
  block: Block,
  text: string,
): Summary | "legacyJson" | "badHeader" {
  if (isBabelSummary(block.summary)) {
    return toBabelSummary(text) ?? "badHeader"
  }
  if (isMarkdownSummary(block.summary)) return toMarkdownSummary(text)
  return "legacyJson"
}

