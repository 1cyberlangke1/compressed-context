import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { localeArgument, type Settings } from "../../shared/settings.ts"
import type { UpdateSettings } from "../types.ts"
import { usePanelData } from "./data-scoped.ts"
import { dropBar, segmentLabel, timeLabel } from "./drops-format.ts"

/** 折叠时预览的条数。 */
const PREVIEW_ROWS = 3

/**
 * 输入：TUI 上下文 + 会话 + 设置 + 写入函数 + 打开面板回调。
 * 输出：可折叠、可点击的「缓存突变」侧栏分区。
 * 预期：开关关闭或没有记录时整个分区不渲染；每行只展示实测事实。
 */
export function DropsSection(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
  readonly onOpen: (messageID: string) => void
}) {
  const theme = props.context.theme
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))
  const data = usePanelData({
    context: props.context,
    sessionID: props.sessionID,
    settings: () => props.settings,
    scope: "drops",
  })
  const visible = createMemo(() => data.drops().slice(-PREVIEW_ROWS).toReversed())
  const hidden = createMemo(() => Math.max(0, data.drops().length - PREVIEW_ROWS))

  /** 输入：无；输出：无；预期：翻转折叠状态并写回设置。 */
  const toggle = (): void => {
    void props.updateSettings((draft) => {
      draft.cacheDropsExpanded = !draft.cacheDropsExpanded
    })
  }

  return (
    <Show
      when={props.settings.cacheDropsEnabled && props.settings.showCacheDrops && data.drops().length > 0}
    >
      <box width="100%" flexDirection="column">
        <box flexDirection="row" height={1} onMouseDown={toggle}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.base}>{props.settings.cacheDropsExpanded ? "▼" : "▶"}</text>
            <text fg={theme.text.base}>
              <b>{copy().drops.title}</b>
            </text>
            <text fg={theme.text.muted}>{`(${data.drops().length.toString()})`}</text>
          </box>
        </box>
        <Show when={props.settings.cacheDropsExpanded}>
          <box flexDirection="column" width="100%" paddingLeft={2}>
            <For each={visible()}>
              {(drop) => (
                <box
                  flexDirection="row"
                  height={1}
                  gap={1}
                  onMouseDown={() => {
                    props.onOpen(drop.messageID)
                  }}
                >
                  <text fg={theme.text.feedback.error.base}>{dropBar(drop.dropPp)}</text>
                  <text fg={theme.text.muted}>{timeLabel(drop.at)}</text>
                  <text fg={theme.text.feedback.error.base}>{`-${drop.dropPp.toFixed(1)}pp`}</text>
                  <text fg={theme.text.muted}>{copy().drops.cause[drop.cause]}</text>
                  <text fg={theme.text.base}>{segmentLabel(drop.breakPoint)}</text>
                </box>
              )}
            </For>
            <Show when={hidden() > 0}>
              <text fg={theme.text.muted}>{copy().drops.more(hidden())}</text>
            </Show>
          </box>
        </Show>
      </box>
    </Show>
  )
}
