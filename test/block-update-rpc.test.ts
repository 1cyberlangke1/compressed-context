import { describe, expect, test } from "vitest"

import { registerSettingsRpc } from "../src/compression/settings-rpc.ts"
import { stateKey, type Block } from "../src/compression/state.ts"
import type { SummaryBlock } from "../src/shared/blocks.ts"

/** 内存 storage：够 state / 设置读写。 */
function memoryStore() {
  const data = new Map<string, unknown>()
  return {
    data,
    get: (key: string) => Promise.resolve(data.get(key)),
    set: (key: string, value: unknown) => {
      data.set(key, value)
      return Promise.resolve()
    },
    remove: (key: string) => {
      data.delete(key)
      return Promise.resolve()
    },
    scan: () => Promise.resolve([...data.keys()].map((key) => ({ key }))),
  }
}

/** 输入：会话位置表；输出：被 registerSettingsRpc 注册的 handlers。 */
function fakeContext(store: ReturnType<typeof memoryStore>) {
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const locations: Record<string, string> = {
    ses_ok: "/work",
    ses_other: "/elsewhere",
  }
  return {
    handlers,
    ctx: {
      location: { directory: "/work" },
      storage: store,
      rpc: {
        register: (_definition: unknown, registered: typeof handlers) => {
          Object.assign(handlers, registered)
          return Promise.resolve({ dispose: () => Promise.resolve() })
        },
      },
      session: {
        get: ({ sessionID }: { sessionID: string }) => {
          const directory = locations[sessionID]
          if (directory === undefined) return Promise.reject(new Error("not found"))
          return Promise.resolve({ location: { directory } })
        },
      },
      model: { list: () => Promise.resolve({ data: [] }) },
    },
  }
}

/** 输入：会话 ID；输出：一条已落盘的 T1 块。预期：正文足以通过最短长度校验。 */
async function seed(store: ReturnType<typeof memoryStore>, sessionID: string): Promise<Block> {
  const block: Block = {
    id: "b1",
    tier: 1,
    height: 1,
    summary: {
      format: "babel",
      title: "旧标题",
      goal: "旧目标",
      text: `T=旧标题|G=旧目标\n${"S[mod]:old ".repeat(30)}`,
    },
    fromId: "m1",
    toId: "m2",
    sourceTokens: 5000,
    summaryTokens: 90,
    at: 1000,
    order: 1,
  }
  await store.set(stateKey(sessionID), { blocks: [block], attempts: 0 })
  return block
}

describe("blockUpdate 真实 handler", () => {
  test("同目录会话能改块，blocksGet 读回新正文", async () => {
    const store = memoryStore()
    const { ctx, handlers } = fakeContext(store)
    await registerSettingsRpc(ctx as never)
    const block = await seed(store, "ses_ok")

    const result = await handlers["blockUpdate"]?.({
      sessionID: "ses_ok",
      blockID: "b1",
      expectedAt: block.at,
      text: `T=新标题|G=新目标\n${"S[mod]:new ".repeat(30)}`,
    })
    expect(result).toEqual({ ok: true })

    const got = (await handlers["blocksGet"]?.({ sessionID: "ses_ok" })) as {
      blocks: readonly SummaryBlock[]
    }
    expect(got.blocks).toHaveLength(1)
    expect(got.blocks[0]?.title).toBe("新标题")
    expect(got.blocks[0]?.body).toContain("S[mod]:new")
    expect(got.blocks[0]?.at).toBe(block.at)
  })

  test("别的目录的会话拒绝写入", async () => {
    const store = memoryStore()
    const { ctx, handlers } = fakeContext(store)
    await registerSettingsRpc(ctx as never)
    const block = await seed(store, "ses_other")

    const result = await handlers["blockUpdate"]?.({
      sessionID: "ses_other",
      blockID: "b1",
      expectedAt: block.at,
      text: "T=a|G=b\nx",
    })
    expect(result).toEqual({ ok: false, code: "foreignSession" })
  })

  test("查不到的会话拒绝写入", async () => {
    const store = memoryStore()
    const { ctx, handlers } = fakeContext(store)
    await registerSettingsRpc(ctx as never)

    const result = await handlers["blockUpdate"]?.({
      sessionID: "ses_missing",
      blockID: "b1",
      expectedAt: 1,
      text: "T=a|G=b\nx",
    })
    expect(result).toEqual({ ok: false, code: "noSession" })
  })

  test("blocksGet 也不返回别的目录会话的块", async () => {
    const store = memoryStore()
    const { ctx, handlers } = fakeContext(store)
    await registerSettingsRpc(ctx as never)
    await seed(store, "ses_other")

    const got = await handlers["blocksGet"]?.({ sessionID: "ses_other" })
    expect(got).toEqual({ blocks: [] })
  })

  test("expectedAt 对不上时回 stale，不写盘", async () => {
    const store = memoryStore()
    const { ctx, handlers } = fakeContext(store)
    await registerSettingsRpc(ctx as never)
    await seed(store, "ses_ok")

    const result = await handlers["blockUpdate"]?.({
      sessionID: "ses_ok",
      blockID: "b1",
      expectedAt: 7,
      text: "T=a|G=b\nxy",
    })
    expect(result).toEqual({ ok: false, code: "stale" })
    const got = (await handlers["blocksGet"]?.({ sessionID: "ses_ok" })) as {
      blocks: readonly SummaryBlock[]
    }
    expect(got.blocks[0]?.title).toBe("旧标题")
  })
})
