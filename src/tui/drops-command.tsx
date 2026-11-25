import type { Context } from "@opencode/plugin/tui/context"
import { createMemo } from "solid-js"

import { resolveMessages } from "../i18n/index.ts"
import { localeArgument, type Settings } from "../shared/settings.ts"

/**
 * 输入：TUI 上下文 + 设置 + 打开面板回调。
 * 输出：`/cache-drops` 斜杠命令与命令面板项。
 * 预期：只负责打开面板；面板数据由 session.panel 里的 DropsView 自己拉取。
 */
export function DropsCommand(props: {
  readonly context: Context
  readonly settings: Settings
  readonly onOpen: () => void
}) {
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))

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
          props.onOpen()
        },
      },
    ],
  }))

  return null
}
