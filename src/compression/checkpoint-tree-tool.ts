import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { countText } from "../shared/tokens.ts"
import { loadServerSettings } from "./settings.ts"
import { isSubagentSession } from "./session-role.ts"
import type { Disposable } from "./settings-rpc.ts"
import { loadState, type Block, type State } from "./state.ts"

const DESCRIPTION =
  "Shows the checkpoint tree: block ids, tiers, and titles. Use the block ids with decompress to restore content."

const CheckpointTreeOutput = Schema.Struct({
  inline: Schema.String,
})

/** 树里的一行：Dewey 编号 + 块 id + 层级 + 可选 token + 可选标题。 */
interface TreeLine {
  readonly path: string
  readonly block: Block
  readonly tokens: number
  readonly title: string
}

/** 输入：全部块 + pending；输出：id → 块映射。 */
function byId(blocks: readonly Block[]): Map<string, Block> {
  return new Map(blocks.map((block) => [block.id, block]))
}

/**
 * 输入：当前块 + 它在树里的 Dewey 路径 + 全部块。
 * 输出：该子树的所有行；长直链折叠成一条区间行，链尾分叉继续展开。
 * 预期：唯一子链（每层恰一个孩子）折叠；分叉正常展开；子块按 order 排。
 */
function subtreeLines(block: Block, path: string, all: Map<string, Block>): TreeLine[] {
  // 沿唯一子链往下走，收集整条链。
  const chain: Block[] = [block]
  let cursor = block
  for (;;) {
    const children = childrenOf(cursor, all)
    if (children.length !== 1) break
    const next = children[0]
    if (next === undefined) break
    cursor = next
    chain.push(cursor)
  }
  const lines: TreeLine[] = []
  if (chain.length >= 3) {
    // 折叠：一条行覆盖整条链，路径写成 <path>-<层数>，行块取链尾。
    const tokens = chain.reduce((sum, item) => sum + countText(JSON.stringify(item.summary)), 0)
    const foldedPath = `${path}-${chain.length.toString()}`
    lines.push({ path: foldedPath, block: cursor, tokens, title: summaryTitleOf(chain) })
    // 链尾若分叉，继续展开（孩子路径接在折叠行之后）。
    childrenOf(cursor, all).forEach((child, index) => {
      lines.push(...subtreeLines(child, `${foldedPath}.${(index + 1).toString()}`, all))
    })
    return lines
  }
  const tokens = countText(JSON.stringify(block.summary))
  lines.push({ path, block, tokens, title: summaryTitleOf([block]) })
  childrenOf(block, all).forEach((child, index) => {
    lines.push(...subtreeLines(child, `${path}.${(index + 1).toString()}`, all))
  })
  return lines
}

/** 输入：父块；输出：合并进它的直接子块（按 order 排）。 */
function childrenOf(parent: Block, all: Map<string, Block>): Block[] {
  const ids = parent.sourceBlockIds ?? []
  const children = ids.map((id) => all.get(id)).filter((block): block is Block => block !== undefined)
  return children.sort((left, right) => left.order - right.order)
}

/** 输入：一条链；输出：第一个非空标题。 */
function summaryTitleOf(chain: readonly Block[]): string {
  for (const block of chain) {
    const title = block.summary.title.trim()
    if (title.length > 0) return title
  }
  return ""
}

/**
 * 输入：压缩状态。
 * 输出：Dewey 编号的树文本；无块时 undefined。
 * 预期：只从 active 顶层块的子树渲染；每行 `编号 [id]:T层 [tok] [标题]`。
 */
export function renderCheckpointTree(state: State, showTokens: boolean): string | undefined {
  const all = byId(state.blocks)
  const consumed = new Set<string>()
  for (const block of state.blocks) {
    for (const source of block.sourceBlockIds ?? []) consumed.add(source)
  }
  const roots = state.blocks
    .filter((block) => !consumed.has(block.id))
    .sort((left, right) => left.order - right.order)
  if (roots.length === 0) return undefined

  const lines: TreeLine[] = roots.flatMap((root, index) => subtreeLines(root, (index + 1).toString(), all))

  const total = lines.reduce((sum, line) => sum + line.tokens, 0)
  const body = lines
    .map((line) => {
      const tier = `T${line.block.tier.toString()} {h${line.block.height.toString()}}`
      const tokens = showTokens ? ` ${line.tokens.toString()}` : ""
      const title = line.title.length > 0 ? ` ${line.title}` : ""
      return `${line.path} ${line.block.id}:${tier}${tokens}${title}`
    })
    .join("\n")
  return `${lines.length.toString()} blocks · ≈${total.toString()} tok\n${body}`
}

/**
 * 输入：服务端插件上下文。
 * 输出：注册 checkpoint_tree 工具，返回注销句柄。
 * 预期：只读；返回摘要树文本，供模型按编号选块 decompress。
 */
export async function registerCheckpointTreeTool(ctx: Plugin.Context): Promise<Disposable> {
  const registration = await ctx.tool.transform((tools) => {
    tools.add({
      name: "checkpoint_tree",
      options: { codemode: false },
      description: DESCRIPTION,
      input: Schema.Struct({}),
      output: CheckpointTreeOutput,
      execute: async (_input, toolCtx) => {
        // 第二道防线：context 钩子已经对子代理隐藏工具，这里再挡一次直接调用。
        if (await isSubagentSession(ctx, toolCtx.sessionID)) {
          return {
            output: { inline: "checkpoint_tree is unavailable in subagent sessions" },
            content: "checkpoint_tree is unavailable in subagent sessions",
          }
        }
        const settings = await loadServerSettings(ctx)
        if (!settings.enableDecompressTool) {
          const message = "checkpoint_tree tool is disabled in settings"
          return { output: { inline: message }, content: message }
        }
        const state = await loadState(ctx.storage, toolCtx.sessionID)
        const tree = renderCheckpointTree(state, settings.showBlockTokens)
        const content = tree ?? "no compressed blocks"
        return { output: { inline: content }, content }
      },
    })
  })
  return registration
}
