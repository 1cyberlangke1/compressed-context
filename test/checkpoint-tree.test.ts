import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { registerCheckpointTreeTool, renderCheckpointTree } from "../src/compression/checkpoint-tree-tool.ts"
import { saveState, type Block, type State, type StorageLike } from "../src/compression/state.ts"
import { CONFIG_FILE } from "../src/shared/config-paths.ts"

const summary = {
  title: "t",
  goal: "g",
  constraints: [],
  decisions: [],
  progress: { completed: [], active: [], blocked: [] },
  open_items: [],
  files: [],
  facts: [],
}

/** 输入：id/tier/order/sourceBlockIds/标题；输出：测试用块。 */
const block = (
  id: string,
  tier: number,
  order: number,
  sourceIds?: string[],
  title?: string,
): Block => ({
  id,
  tier,
  height: tier,
  summary: { ...summary, title: title ?? `title ${id}` },
  fromId: `${id}-from`,
  toId: `${id}-to`,
  sourceTokens: 1000,
  summaryTokens: 100,
  at: order,
  order,
  ...(sourceIds === undefined ? {} : { sourceBlockIds: sourceIds }),
})

describe("renderCheckpointTree", () => {
  it("无块时返回 undefined", () => {
    const state: State = { blocks: [], attempts: 0 }
    expect(renderCheckpointTree(state, true)).toBeUndefined()
  })

  it("单块树：顶层编号 1，带 id、tier、token、标题", () => {
    const state: State = { blocks: [block("b1", 1, 1, undefined, "会话目标确立")], attempts: 0 }
    const tree = renderCheckpointTree(state, true)
    expect(tree).toBeDefined()
    expect(tree).toContain("1 blocks")
    expect(tree).toContain("1 b1:T1 {h1} ")
    expect(tree).toContain("会话目标确立")
  })

  it("金字塔：两个 T1 合成 T2，子块缩进在父下，编号 1.1 / 1.2", () => {
    const state: State = {
      blocks: [
        block("b3", 2, 1, ["b1", "b2"], "合并"),
        block("b1", 1, 1, undefined, "左"),
        block("b2", 1, 2, undefined, "右"),
      ],
      attempts: 0,
    }
    const tree = renderCheckpointTree(state, true)
    expect(tree).toBeDefined()
    const lines = (tree ?? "").split("\n")
    expect(lines[0]).toContain("3 blocks")
    // 顶层是 b3；子块按 order 排 1.1=b1、1.2=b2。
    expect(lines[1]).toContain("1 b3:T2")
    expect(lines[2]).toContain("1.1 b1:T1")
    expect(lines[2]).toContain("左")
    expect(lines[3]).toContain("1.2 b2:T1")
    expect(lines[3]).toContain("右")
  })

  it("长直链折叠：b4→b3→b2→b1 单链折叠成一行区间", () => {
    const state: State = {
      blocks: [
        block("b4", 4, 1, ["b3"], "塔尖"),
        block("b3", 3, 2, ["b2"]),
        block("b2", 2, 3, ["b1"]),
        block("b1", 1, 4),
      ],
      attempts: 0,
    }
    const tree = renderCheckpointTree(state, true)
    expect(tree).toBeDefined()
    const dataLines = (tree ?? "").split("\n").slice(1)
    // 4 个块折叠成 1 行（+合计行）：路径 1-4，块 id 是链尾 b1。
    expect(dataLines).toHaveLength(1)
    expect(dataLines[0]).toContain("1-4 b1:T1")
    expect(dataLines[0]).toContain("塔尖")
  })

  it("折叠链尾分叉：直链折叠成一行，分叉孩子接在折叠行下", () => {
    const state: State = {
      blocks: [
        block("b5", 5, 1, ["b4"], "根"),
        block("b4", 4, 2, ["b3"]),
        block("b3", 3, 3, ["b1", "b2"]),
        block("b1", 1, 4, undefined, "甲"),
        block("b2", 1, 5, undefined, "乙"),
      ],
      attempts: 0,
    }
    const tree = renderCheckpointTree(state, true)
    expect(tree).toBeDefined()
    const lines = (tree ?? "").split("\n")
    // b5→b4→b3 是 3 节点直链，折叠成 1-3；b3 分叉出 b1、b2，编号接 1-3.1 / 1-3.2。
    expect(lines[1]).toContain("1-3 b3:T3")
    expect(lines[1]).toContain("根")
    expect(lines[2]).toContain("1-3.1 b1:T1")
    expect(lines[2]).toContain("甲")
    expect(lines[3]).toContain("1-3.2 b2:T1")
    expect(lines[3]).toContain("乙")
  })

  it("showTokens=false 时省略 token 列", () => {
    const state: State = { blocks: [block("b1", 1, 1)], attempts: 0 }
    const tree = renderCheckpointTree(state, false)
    expect(tree).toBeDefined()
    expect(tree).not.toMatch(/b1:T1\/d1 \d/)
  })

  it("两棵顶层树：编号 1、2", () => {
    const state: State = {
      blocks: [block("b2", 1, 2), block("b1", 1, 1)],
      attempts: 0,
    }
    const tree = renderCheckpointTree(state, false)
    expect(tree).toBeDefined()
    expect(tree).toContain("2 blocks")
    expect(tree).toContain("1 b1:T1")
    expect(tree).toContain("2 b2:T1")
  })
})

type TreeExecute = (
  input: Record<string, never>,
  toolCtx: { sessionID: string },
) => Promise<{ output: { inline: string }; content: string }>

/** 输入：无；输出：内存 storage。预期：state 直接存进 Map，设置走项目配置文件。 */
function createStorage(): StorageLike {
  const data = new Map<string, Schema.Json>()
  return {
    get: (key) => Promise.resolve(data.get(key)),
    set: (key, value) => {
      data.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      data.delete(key)
      return Promise.resolve()
    },
  }
}

/**
 * 输入：两个工具开关。
 * 输出：checkpoint_tree 的 execute。
 * 预期：配置写进独立临时项目目录，state 里放一个块，调用返回结构化树。
 */
async function setupTree(settings: {
  readonly enableCheckpointTreeTool: boolean
  readonly enableDecompressTool: boolean
}): Promise<TreeExecute> {
  const directory = mkdtempSync(join(tmpdir(), "cc-checkpoint-tree-"))
  mkdirSync(join(directory, ".opencode"), { recursive: true })
  writeFileSync(join(directory, ".opencode", CONFIG_FILE), JSON.stringify(settings), "utf8")
  const storage = createStorage()
  await saveState(storage, "ses_a", { blocks: [block("b1", 1, 1)], attempts: 0 })

  let execute: TreeExecute | undefined
  const ctx = {
    storage,
    location: { directory },
    session: {
      get: () => Promise.resolve({ location: { directory } }),
    },
    tool: {
      transform: (callback: (tools: { add: (tool: { execute: TreeExecute }) => void }) => void) => {
        callback({
          add: (tool) => {
            execute = tool.execute
          },
        })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
  } as unknown as Plugin.Context

  await registerCheckpointTreeTool(ctx)
  if (execute === undefined) throw new Error("checkpoint_tree tool was not registered")
  return execute
}

describe("checkpoint_tree 独立开关", () => {
  it("开启 checkpoint_tree、关闭 decompress 时仍然返回树", async () => {
    const execute = await setupTree({ enableCheckpointTreeTool: true, enableDecompressTool: false })
    const result = await execute({}, { sessionID: "ses_a" })
    expect(result.content).toContain("1 blocks")
    expect(result.content).not.toContain("disabled")
  })

  it("关闭 checkpoint_tree、开启 decompress 时返回禁用提示", async () => {
    const execute = await setupTree({ enableCheckpointTreeTool: false, enableDecompressTool: true })
    const result = await execute({}, { sessionID: "ses_a" })
    expect(result.content).toContain("disabled")
  })
})
