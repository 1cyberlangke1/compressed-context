import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import type { Messages } from "../i18n/index.ts"
import {
  checkLatestVersion,
  startUpdate,
  updateCommandLine,
  type UpdateCheckResult,
  type UpdateProgress,
  type UpdateStartResult,
} from "../shared/update.ts"

/** 检查与启动的注入点；测试用它避开真实网络和真实子进程。 */
export interface UpdateDeps {
  readonly check: () => Promise<UpdateCheckResult>
  readonly run: (onProgress: UpdateProgress) => Promise<UpdateStartResult>
}

/** 更新菜单的可注入依赖与结果观察器。 */
export interface UpdateMenuOptions {
  readonly deps?: UpdateDeps
  readonly onResult?: (result: UpdateCheckResult) => void
}

/** 生产依赖：真实 registry 查询 + 固定命令执行。 */
export const DEFAULT_UPDATE_DEPS: UpdateDeps = {
  check: () => checkLatestVersion(),
  run: (onProgress) => startUpdate({ onProgress }),
}

/** 完成 toast 保留 10 秒，足够用户看到重启提示。 */
const RESULT_TOAST_DURATION_MS = 10_000

/**
 * 输入：TUI 上下文、标题与初始进度。
 * 输出：可更新文案的进度框句柄。
 * 预期：进度框使用现有 dialog 层原地刷新；完成时由调用方关闭，不排队制造延迟。
 */
function showProgress(context: Context, title: string, initial: string) {
  const [message, setMessage] = createSignal(initial)
  context.ui.dialog.show(() => (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <text fg={context.theme.text.base}>
        <b>{title}</b>
      </text>
      <text fg={context.theme.text.muted}>{message()}</text>
    </box>
  ))
  return {
    update: (line: string) => {
      setMessage(line)
    },
    close: () => {
      context.ui.dialog.clear()
    },
  }
}

/**
 * 输入：TUI 上下文、文案访问器、可注入依赖与结果观察器。
 * 输出：检查并执行更新的异步函数；执行过更新时返回 true。
 * 预期：发现新版时先确认；确认后只显示原地更新的进度框，结束以 toast 报成功或失败；
 *       已是最新或检查失败直接 alert，不打开二级结果菜单。
 */
export function createUpdateMenu(
  context: Context,
  copy: () => Messages,
  options: UpdateMenuOptions = {},
): () => Promise<boolean> {
  const deps = options.deps ?? DEFAULT_UPDATE_DEPS
  return async () => {
    const text = copy()
    const result = await deps.check().catch(
      (): UpdateCheckResult => ({ kind: "failed", reason: "network" }),
    )
    options.onResult?.(result)

    if (result.kind === "up-to-date") {
      await context.ui.dialog.alert({ title: text.update.title, message: text.update.upToDate })
      return false
    }
    if (result.kind === "failed") {
      await context.ui.dialog.alert({ title: text.update.title, message: text.update.failed })
      return false
    }

    const confirmed = await context.ui.dialog.confirm({
      title: text.update.title,
      message: text.update.confirm(result.currentVersion, result.latestVersion),
      label: { confirm: text.update.updateNow, cancel: text.update.cancel },
    })
    if (confirmed !== true) return false

    const progress = showProgress(context, text.update.title, text.update.running)
    const finished = await deps.run(progress.update).catch(
      (): UpdateStartResult => ({ ok: false, command: updateCommandLine() }),
    )
    progress.close()
    context.ui.toast.show({
      title: text.update.title,
      message: finished.ok ? text.update.succeeded : `${text.update.runFailed} ${finished.command}`,
      variant: finished.ok ? "success" : "error",
      duration: RESULT_TOAST_DURATION_MS,
    })
    return true
  }
}
