import type { Context } from "@opencode/plugin/tui/context"
import { createMemo } from "solid-js"

import { resolveMessages } from "../i18n/index.ts"
import { localeArgument, type Settings } from "../shared/settings.ts"

/**
 * 输入：TUI 上下文 + 设置 + 打开弹窗回调。
 * 输出：`/cache-drops` 斜杠命令与命令面板项。
 * 预期：只负责定位当前会话并打开阅读弹窗；不在会话里时提示原因。
 */
export function DropsCommand(props: {
  readonly context: Context
  readonly settings: Settings
  readonly onOpen: (sessionID: string) => void
}) {
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))

  /** 输入：无；输出：无；预期：取当前路由的会话；没有会话就不打开空弹窗。 */
  const open = (): void => {
    const route = props.context.ui.router.current()
    if (route.type !== "session") {
      props.context.ui.toast.show({ message: copy().drops.noSession, variant: "warning" })
      return
    }
    props.onOpen(route.sessionID)
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "compressed-context.cache-drops",
        title: copy().drops.command.title,
        description: copy().drops.command.description,
        group: copy().drops.command.group,
        slash: { name: "cache-drops" },
        palette: true,
        run() {
          open()
        },
      },
    ],
  }))

  return null
}
