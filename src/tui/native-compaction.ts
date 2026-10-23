import type { Context } from "@opencode/plugin/tui/context"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

import { resolveMessages } from "../i18n/index.ts"
import { localeArgument, type Settings } from "../shared/settings.ts"
import type { UpdateSettings } from "./types.ts"

/** OpenCode 原生压缩的检测结果；enabled 时 path 是建议写入的配置文件。 */
export type NativeCompactionState =
  | { readonly status: "disabled" }
  | { readonly status: "enabled"; readonly path: string }

/** 写入结果；失败时 error 是可直接展示的原因。 */
export type NativeCompactionWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** 输入：无；输出：用户全局 OpenCode 配置路径。 */
function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json")
}

/** 输入：未知异常；输出：人类可读错误。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 输入：未知异常；输出：是否是 ENOENT。 */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

/**
 * 输入：TUI 插件上下文。
 * 输出：原生压缩是否已关闭，以及需要写入的配置文件路径。
 * 预期：按配置条目顺序取最后一个显式 auto；没有任何配置时按默认开启处理。
 */
export async function detectNativeCompaction(context: Context): Promise<NativeCompactionState> {
  const entries = await context.client.config.get(
    context.location === undefined ? undefined : { location: { directory: context.location.directory } },
  )
  let auto: boolean | undefined
  let target: string | undefined
  let lastPath: string | undefined

  for (const entry of entries) {
    if (entry.type !== "document") continue
    const path = entry.path
    if (path !== undefined) lastPath = path
    const compaction = entry.info.compaction
    if (compaction === undefined) continue
    if (path !== undefined) target = path
    if (compaction.auto !== undefined) auto = compaction.auto
  }

  if (auto === false) return { status: "disabled" }
  return { status: "enabled", path: target ?? lastPath ?? globalConfigPath() }
}

/**
 * 输入：要修改的配置文件路径。
 * 输出：成功或解析/写入错误。
 * 预期：用 jsonc-parser 保留注释和格式；不做备份；解析失败绝不写文件。
 */
export async function disableNativeCompaction(path: string): Promise<NativeCompactionWriteResult> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (!isNotFound(error)) return { ok: false, error: errorMessage(error) }
    text = "{}"
  }

  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  const [first] = errors
  if (first !== undefined) {
    return {
      ok: false,
      error: `JSONC parse failed: ${printParseErrorCode(first.error)} at ${first.offset.toString()}`,
    }
  }

  const next = applyEdits(
    text,
    modify(text, ["compaction", "auto"], false, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )

  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, next, "utf8")
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * 输入：TUI 上下文、当前设置、设置写入函数。
 * 输出：无。
 * 预期：原生压缩开启且用户未选择不再提醒时弹三选一；只有选择关闭才写配置。
 */
export async function maybePromptNativeCompaction(
  context: Context,
  settings: Settings,
  updateSettings: UpdateSettings,
): Promise<void> {
  if (!settings.enabled || settings.nativeCompactionPromptDismissed) return

  let state: NativeCompactionState
  try {
    state = await detectNativeCompaction(context)
  } catch {
    return
  }
  if (state.status === "disabled") return

  const copy = resolveMessages(localeArgument(settings.locale)).nativeCompaction
  const picked = await context.ui.dialog.select<"disable" | "keep" | "dismiss">({
    title: copy.title,
    options: [
      {
        title: copy.disable,
        value: "disable",
        description: copy.description(state.path),
      },
      { title: copy.keep, value: "keep" },
      { title: copy.dismiss, value: "dismiss" },
    ],
  })

  if (picked === "disable") {
    const result = await disableNativeCompaction(state.path)
    if (!result.ok) {
      context.ui.toast.show({ message: copy.writeFailed(result.error), variant: "error" })
      return
    }
    context.ui.toast.show({ message: copy.disabled, variant: "success" })
    return
  }

  if (picked === "dismiss") {
    await updateSettings((draft) => {
      draft.nativeCompactionPromptDismissed = true
    })
  }
}
