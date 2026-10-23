import type { Context } from "@opencode/plugin/tui/context"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { disableNativeCompaction } from "../src/compression/native-compaction.ts"
import { detectNativeCompaction, maybePromptNativeCompaction } from "../src/tui/native-compaction-dialog.ts"

/** 输入：无；输出：临时目录路径；预期：测试结束由调用方删除。 */
async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "compressed-context-native-"))
}

/** 输入：配置条目；输出：detectNativeCompaction 的假 Context。 */
function contextWith(entries: readonly unknown[]): Context {
  return {
    client: {
      config: {
        get: () => Promise.resolve(entries),
      },
    },
    location: undefined,
  } as unknown as Context
}

/** 输入：配置条目 + 用户选择；输出：带假 dialog/toast 的 Context。 */
function promptContext(
  entries: readonly unknown[],
  picked: "disable" | "keep" | "dismiss",
  toasts: { message: string; variant?: string }[],
): Context {
  return {
    client: {
      config: {
        get: () => Promise.resolve(entries),
      },
      rpc: () => ({
        nativeCompactionDisable: (input: { readonly path: string }) => disableNativeCompaction(input.path),
      }),
    },
    location: undefined,
    ui: {
      dialog: {
        select: () => Promise.resolve(picked),
      },
      toast: {
        show: (toast: { message: string; variant?: string }) => {
          toasts.push(toast)
        },
      },
    },
  } as unknown as Context
}

describe("detectNativeCompaction", () => {
  it("显式 auto=false 视为已关闭", async () => {
    const state = await detectNativeCompaction(
      contextWith([{ type: "document", path: "/tmp/opencode.json", info: { compaction: { auto: false } } }]),
    )
    expect(state).toEqual({ status: "disabled" })
  })

  it("auto=true 时返回最后一份 compaction 配置路径", async () => {
    const state = await detectNativeCompaction(
      contextWith([
        { type: "document", path: "/tmp/a.json", info: { compaction: { auto: true } } },
        { type: "document", path: "/tmp/b.json", info: {} },
      ]),
    )
    expect(state).toEqual({ status: "enabled", path: "/tmp/a.json" })
  })

  it("没有 compaction 时用最后一份配置路径", async () => {
    const state = await detectNativeCompaction(
      contextWith([{ type: "document", path: "/tmp/a.json", info: {} }]),
    )
    expect(state).toEqual({ status: "enabled", path: "/tmp/a.json" })
  })
})

describe("maybePromptNativeCompaction", () => {
  it("选择关闭后写配置并提示成功", async () => {
    const directory = await tempDirectory()
    const path = join(directory, "opencode.json")
    const toasts: { message: string; variant?: string }[] = []
    const settings: Settings = { ...DEFAULT_SETTINGS }
    try {
      await writeFile(path, '{"compaction":{"auto":true}}', "utf8")
      const updateSettings = (mutation: (draft: Settings) => void): Promise<void> => {
        mutation(settings)
        return Promise.resolve()
      }
      await maybePromptNativeCompaction(
        promptContext([{ type: "document", path, info: { compaction: { auto: true } } }], "disable", toasts),
        settings,
        updateSettings,
      )
      expect(await readFile(path, "utf8")).toMatch(/"auto":\s*false/)
      expect(toasts.at(-1)?.variant).toBe("success")
      expect(settings.nativeCompactionPromptDismissed).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("选择不再提醒只写 settings，不碰配置文件", async () => {
    const directory = await tempDirectory()
    const path = join(directory, "opencode.json")
    const toasts: { message: string; variant?: string }[] = []
    const settings: Settings = { ...DEFAULT_SETTINGS }
    try {
      const updateSettings = (mutation: (draft: Settings) => void): Promise<void> => {
        mutation(settings)
        return Promise.resolve()
      }
      await maybePromptNativeCompaction(
        promptContext([{ type: "document", path, info: { compaction: { auto: true } } }], "dismiss", toasts),
        settings,
        updateSettings,
      )
      expect(settings.nativeCompactionPromptDismissed).toBe(true)
      await expect(access(path)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("disableNativeCompaction", () => {
  it("保留 JSONC 注释并写入 auto=false，不创建备份", async () => {
    const directory = await tempDirectory()
    const path = join(directory, "opencode.jsonc")
    try {
      await writeFile(
        path,
        '{\n  // keep this comment\n  "compaction": {\n    "auto": true,\n    "keep": { "tokens": 15000 }\n  }\n}\n',
        "utf8",
      )
      const result = await disableNativeCompaction(path)
      expect(result).toEqual({ ok: true })
      const text = await readFile(path, "utf8")
      expect(text).toContain("// keep this comment")
      expect(text).toMatch(/"auto": false/)
      await expect(access(`${path}.bak`)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("没有 compaction 时创建对象", async () => {
    const directory = await tempDirectory()
    const path = join(directory, "opencode.json")
    try {
      await writeFile(path, '{\n  "shell": "bash"\n}\n', "utf8")
      const result = await disableNativeCompaction(path)
      expect(result).toEqual({ ok: true })
      const text = await readFile(path, "utf8")
      expect(text).toMatch(/"compaction"/)
      expect(text).toMatch(/"auto": false/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("解析失败时报错且不写文件", async () => {
    const directory = await tempDirectory()
    const path = join(directory, "opencode.json")
    const original = '{"compaction": {"auto": }}'
    try {
      await writeFile(path, original, "utf8")
      const result = await disableNativeCompaction(path)
      expect(result.ok).toBe(false)
      expect(await readFile(path, "utf8")).toBe(original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
