import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import type { SummaryFields, SummaryInput } from "../src/compression/schema.ts"
import { DEFAULT_SERVER_SETTINGS } from "../src/compression/settings.ts"
import { saveState, type StorageLike } from "../src/compression/state.ts"
import { registerCompressTool, type CompressToolHandle } from "../src/compression/tool.ts"
import { registerDecompressTool } from "../src/compression/decompress-tool.ts"
import type { MessageLike } from "../src/compression/select.ts"
import type { SummaryFormat } from "../src/shared/settings.ts"

/** 输入：无；输出：内存 storage 替身，并记录读取过的 key。 */
function createStorage(): StorageLike & { readonly reads: string[] } {
  const data = new Map<string, unknown>()
  const reads: string[] = []
  return {
    reads,
    get(key) {
      reads.push(key)
      return Promise.resolve(data.get(key) as Schema.Json | undefined)
    },
    set(key, value) {
      data.set(key, value)
      return Promise.resolve()
    },
    remove(key) {
      data.delete(key)
      return Promise.resolve()
    },
  }
}

/** 输入：文本；输出：可压缩的 user 消息。 */
function message(id: string, text: string): MessageLike {
  return { id, role: "user", content: [{ type: "text", text }] }
}

/** 输入：无；输出：满足最小长度的摘要。 */
function summary(): SummaryFields {
  return {
    title: "tool test",
    goal: "x".repeat(260),
    constraints: [],
    decisions: [],
    open_items: [],
    files: [],
    facts: [],
    progress: { completed: [], active: [], blocked: [] },
  }
}

type ToolExecute = (
  input: SummaryInput,
  toolCtx: { sessionID: string },
) => Promise<{ output: { block?: string; status: string; error?: string }; content: string }>

type DecompressExecute = (
  input: { block: string; full: boolean },
  toolCtx: { sessionID: string },
) => Promise<{
  output: { inline?: string; path?: string; tokens?: number; error?: string }
  content: string
}>

/** 宿主传给 transform 的工具定义；只取本测试关心的字段。 */
interface CapturedTool {
  readonly description: string
  readonly input: unknown
  readonly execute: ToolExecute
}

/** 输入：schema + 值；输出：能否解码成功；预期：必填字段缺失时报错，多余字段默认忽略。 */
function decodes(schema: unknown, value: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(value)
    return true
  } catch {
    return false
  }
}

/**
 * 输入：storage + 可选 terminal + 可选摘要格式。
 * 输出：捕获的 execute、工具定义读取器、注册句柄。
 * 预期：transform 替身会在 reload 时重跑回调，用来验证 setFormat 真的换了工具。
 */
async function setup(input: {
  storage: StorageLike & { readonly reads: string[] }
  terminal?: string
  format?: SummaryFormat
}): Promise<{
  execute: ToolExecute
  reads: string[]
  handle: CompressToolHandle
  tool: () => CapturedTool
}> {
  const captured: { current?: CapturedTool } = {}
  let render: (() => void) | undefined
  const ctx = {
    storage: input.storage,
    session: {
      get: () => Promise.resolve({ model: { providerID: "fake", id: "model" } }),
      compact: () => Promise.resolve(),
    },
    tool: {
      transform: (fn: (editor: { add: (tool: CapturedTool) => void }) => void) => {
        render = () => {
          fn({ add: (tool) => (captured.current = tool) })
        }
        render()
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      reload: () => {
        render?.()
        return Promise.resolve()
      },
    },
  } as unknown as Plugin.Context
  await saveState(input.storage, "ses_a", {
    blocks: [],
    attempts: 0,
    ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
  })
  if (input.format !== undefined) {
    await input.storage.set("settings", { ...DEFAULT_SERVER_SETTINGS, summaryFormat: input.format })
  }
  const cache = new Map<string, readonly MessageLike[]>([
    ["ses_a", [message("m1", "a".repeat(6_000))]],
  ])
  const handle = await registerCompressTool(ctx, cache)
  const tool = (): CapturedTool => {
    const current = captured.current
    if (current === undefined) throw new Error("compress tool was not registered")
    return current
  }
  return { execute: tool().execute, reads: input.storage.reads, handle, tool }
}

/** 输入：storage；输出：decompress 工具的 execute；预期：捕获 transform 注册的定义。 */
async function setupDecompress(storage: StorageLike): Promise<DecompressExecute> {
  let execute: DecompressExecute | undefined
  const ctx = {
    storage,
    tool: {
      transform: (fn: (editor: { add: (tool: { execute: DecompressExecute }) => void }) => void) => {
        fn({ add: (tool) => (execute = tool.execute) })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
  } as unknown as Plugin.Context
  await registerDecompressTool(ctx)
  if (execute === undefined) throw new Error("decompress tool was not registered")
  return execute
}

describe("compress tool", () => {
  it("按会话模型窗口算摘要上限，而不是全局 window:last", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    await storage.set("window:last", 50_000)
    const { execute, reads } = await setup({ storage })
    const result = await execute(summary(), { sessionID: "ses_a" })
    expect(result.output.status).toBe("queued")
    expect(reads).toContain("window:fake/model")
    expect(reads).not.toContain("window:last")
  })

  it("允许省略可选字段，只给 goal", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    const { execute } = await setup({ storage })
    const result = await execute({ goal: "x".repeat(260) }, { sessionID: "ses_a" })
    expect(result.output.status).toBe("queued")
  })

  it("终止态拒绝压缩", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    const { execute } = await setup({ storage, terminal: "stop now" })
    const result = await execute(summary(), { sessionID: "ses_a" })
    expect(result.output.status).toBe("error")
    expect(result.output.error).toContain("stop now")
    expect(result.output.block).toBeUndefined()
    expect(result.content).toContain("stop now")
  })
})

describe("decompress tool", () => {
  it("失败时 output 带 error，不返回空壳", async () => {
    const storage = createStorage()
    const execute = await setupDecompress(storage)
    const result = await execute({ block: "", full: false }, { sessionID: "ses_a" })
    expect(result.output.error).toContain("block is required")
    expect(result.output.inline).toBeUndefined()
    expect(result.content).toContain("ERROR:")
  })

  it("工具关闭时 output 也带 error", async () => {
    const storage = createStorage()
    await storage.set("settings", { ...DEFAULT_SERVER_SETTINGS, enableDecompressTool: false })
    const execute = await setupDecompress(storage)
    const result = await execute({ block: "b1", full: false }, { sessionID: "ses_a" })
    expect(result.output.error).toContain("disabled")
    expect(result.output.inline).toBeUndefined()
  })
})

describe("compress 工具随摘要格式变化", () => {
  it("默认 markdown：只讲 markdown 写法，参数只收 markdown", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    const { tool } = await setup({ storage })
    const current = tool()
    expect(current.description).toContain("Return ONLY markdown")
    expect(current.description).not.toContain("Return ONLY Babel text")
    expect(current.description).not.toContain('"goal": "required')
    expect(decodes(current.input, { markdown: "# t\n## Goal\nx" })).toBe(true)
    expect(decodes(current.input, { goal: "x" })).toBe(false)
  })

  it("json：只讲 JSON 形状，参数要求 goal", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    const { tool } = await setup({ storage, format: "json" })
    const current = tool()
    expect(current.description).toContain('"goal": "required')
    expect(current.description).not.toContain("Return ONLY markdown")
    expect(current.description).not.toContain("Return ONLY Babel text")
    expect(decodes(current.input, { goal: "x" })).toBe(true)
    expect(decodes(current.input, {})).toBe(false)
    expect(decodes(current.input, { markdown: "# t" })).toBe(false)
  })

  it("babel：只讲 T/G 首行，参数要求 babel", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    const { tool } = await setup({ storage, format: "babel" })
    const current = tool()
    expect(current.description).toContain("Return ONLY Babel text")
    expect(current.description).toContain("T=<short title>|G=<one-line goal>")
    expect(current.description).not.toContain("Return ONLY markdown")
    expect(current.description).not.toContain('"goal": "required')
    expect(decodes(current.input, { babel: "T=t|G=g" })).toBe(true)
    expect(decodes(current.input, { markdown: "# t" })).toBe(false)
  })

  it("setFormat 后描述与参数立刻切换", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    const { tool, handle } = await setup({ storage })
    expect(tool().description).toContain("Return ONLY markdown")
    await handle.setFormat("babel")
    expect(tool().description).toContain("Return ONLY Babel text")
    expect(decodes(tool().input, { babel: "T=t|G=g" })).toBe(true)
    expect(decodes(tool().input, { markdown: "# t" })).toBe(false)
  })
})
