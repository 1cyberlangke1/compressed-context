import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context"

import type { Messages } from "../i18n/index.ts"
import {
  checkLatestVersion,
  startUpdate,
  type UpdateCheckResult,
  type UpdateStartResult,
} from "../shared/update.ts"
import { PLUGIN_VERSION } from "../shared/version.ts"

/** 更新菜单动作；当前/最新版本与状态只是无副作用的展示项。 */
type UpdateChoice = "current" | "latest" | "status" | "update" | "again" | "close"

/** 检查与启动的注入点；测试用它避开真实网络和真实子进程。 */
export interface UpdateDeps {
  readonly check: () => Promise<UpdateCheckResult>
  readonly start: () => Promise<UpdateStartResult>
}

/** 生产依赖：真实 registry 查询 + 固定命令启动。 */
export const DEFAULT_UPDATE_DEPS: UpdateDeps = {
  check: () => checkLatestVersion(),
  start: () => startUpdate(),
}

/** 输入：检查结果 + 文案；输出：结果菜单首行的状态文案。
 *  预期：三种结果各对应一条已翻译文案，失败时不暴露底层原因。 */
function statusText(result: UpdateCheckResult, copy: Messages): string {
  if (result.kind === "failed") return copy.update.failed
  return result.kind === "up-to-date" ? copy.update.upToDate : copy.update.available
}

/** 输入：检查结果 + 文案；输出：结果菜单里可选的展示/动作项。
 *  预期：当前/最新版本与状态始终展示；只有发现新版本才追加立即更新，
 *        重新检查与关闭在所有状态都存在。展示项被选择时由调用方原地重开菜单。 */
function buildChoices(result: UpdateCheckResult, copy: Messages): DialogSelectOption<UpdateChoice>[] {
  const latest = result.kind === "failed" ? undefined : result.latestVersion
  const options: DialogSelectOption<UpdateChoice>[] = [
    {
      title: copy.update.current,
      value: "current",
      footer: `v${PLUGIN_VERSION}`,
    },
    {
      title: copy.update.latest,
      value: "latest",
      footer: latest === undefined ? copy.noData : `v${latest}`,
    },
    { title: statusText(result, copy), value: "status" },
  ]
  if (result.kind === "update-available") {
    options.push({ title: copy.update.updateNow, value: "update" })
  }
  options.push(
    { title: copy.update.checkAgain, value: "again" },
    { title: copy.update.close, value: "close" },
  )
  return options
}

/**
 * 输入：TUI 上下文、文案访问器、可注入依赖。
 * 输出：打开更新菜单的异步函数。
 * 预期：每次检查只查一次 registry；当前/最新版本是纯展示项，状态与动作跟随检查结果；
 *       立即更新只启动固定命令，不修改设置，也不持久化「最新版」状态。
 */
export function createUpdateMenu(
  context: Context,
  copy: () => Messages,
  deps: UpdateDeps = DEFAULT_UPDATE_DEPS,
): () => Promise<void> {
  return async () => {
    menu: for (;;) {
      const text = copy()
      const result = await deps.check().catch(
        (): UpdateCheckResult => ({ kind: "failed", reason: "network" }),
      )
      for (;;) {
        const choice = await context.ui.dialog.select<UpdateChoice>({
          title: text.update.title,
          options: buildChoices(result, text),
          current: result.kind === "update-available" ? "update" : "again",
        })
        if (choice === undefined || choice === "close") return
        if (choice === "again") continue menu
        if (choice === "current" || choice === "latest" || choice === "status") continue

        const started = await deps.start()
        if (started.ok) {
          context.ui.toast.show({ message: text.update.started, variant: "info" })
        } else {
          context.ui.toast.show({
            message: `${text.update.startFailed} ${started.command}`,
            variant: "error",
          })
        }
        return
      }
    }
  }
}
