import type { RGBA } from "@opentui/core"

import type { Messages } from "../i18n/index.ts"
import type { UpdateCheckResult } from "../shared/update.ts"
import { PLUGIN_VERSION } from "../shared/version.ts"

/** 输入：更新状态的语义颜色；输出：主菜单更新项可用的样式。 */
export interface UpdateEntryColors {
  readonly warning: RGBA
  readonly error: RGBA
}

/** 输入：更新检查结果；输出：更新入口标题、footer 与颜色。 */
export interface UpdateEntryState {
  readonly title: string
  readonly footer?: string
  readonly footerColor?: RGBA
}

/**
 * 输入：文案、最近一次检查结果与主题色。
 * 输出：主菜单更新项。
 * 预期：标题始终显示当前版本；发现新版才追加星标并使用 warning 色。
 */
export function updateEntryState(
  copy: Messages,
  result: UpdateCheckResult | undefined,
  colors: UpdateEntryColors,
): UpdateEntryState {
  const title = `${copy.update.checkUpdates} v${PLUGIN_VERSION}${result?.kind === "update-available" ? " *" : ""}`
  if (result === undefined) return { title }
  if (result.kind === "failed") {
    return { title, footer: copy.update.failed, footerColor: colors.error }
  }
  if (result.kind === "up-to-date") {
    return { title, footer: copy.update.upToDate }
  }
  return {
    title,
    footer: copy.update.latestFooter(result.latestVersion),
    footerColor: colors.warning,
  }
}
