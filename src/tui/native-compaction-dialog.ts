import type { Context } from "@opencode/plugin/tui/context"
import { homedir } from "node:os"
import { join } from "node:path"

import { resolveMessages } from "../i18n/index.ts"
import { contextRpc, rpcLocation } from "../shared/rpc.ts"
import { localeArgument, type Settings } from "../shared/settings.ts"
import type { UpdateSettings } from "./types.ts"

/** OpenCode 原生压缩的检测结果；enabled 时 path 是建议写入的配置文件。 */
export type NativeCompactionState =
  | { readonly status: "disabled" }
  | { readonly status: "enabled"; readonly path: string }

/** 输入：无；输出：用户全局 OpenCode 配置路径。 */
function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json")
}

/** 输入：绝对路径；输出：把用户目录缩成 `~` 的展示路径。 */
function displayPath(path: string): string {
  const slash = (value: string): string => value.replaceAll("\\", "/")
  const home = slash(homedir())
  const normalized = slash(path)
  if (normalized === home) return "~"
  if (normalized.startsWith(`${home}/`)) return `~${normalized.slice(home.length)}`
  return normalized
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

/** 输入：TUI 上下文、路径；输出：服务端写配置结果。预期：jsonc-parser 不进入 TUI 插件依赖图。 */
async function disableNativeCompaction(
  context: Context,
  path: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  return contextRpc(context.client).nativeCompactionDisable({ path }, rpcLocation(context))
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
    title: `${copy.title}\n${displayPath(state.path)}`,
    options: [
      {
        title: copy.disable,
        value: "disable",
      },
      { title: copy.keep, value: "keep" },
      { title: copy.dismiss, value: "dismiss" },
    ],
  })

  if (picked === "disable") {
    const result = await disableNativeCompaction(context, state.path)
    if (!result.ok) {
      context.ui.toast.show({ message: copy.writeFailed(result.error ?? "unknown error"), variant: "error" })
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
