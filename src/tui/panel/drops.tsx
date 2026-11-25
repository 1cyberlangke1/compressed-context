import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { localeArgument, type Settings } from "../../shared/settings.ts"
import type { UpdateSettings } from "../types.ts"
import { usePanelData } from "./data-scoped.ts"
import { segmentLabel, timeLabel } from "./drops-format.ts"

/** 侧栏最多预览的记录数；更多记录只在弹窗里完整查看。 */
const SIDEBAR_ROWS = 10

/**
 * 输入：TUI 上下文 + 会话 + 设置 + 写入函数 + 打开弹窗回调。
 * 输出：与摘要块同款的折叠分区：最近 10 条记录 + hover 动画箭头。
 * 预期：列表在固定高度内滚动；点行打开弹窗，弹窗里能看到全部记录。
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
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [frame, setFrame] = createSignal(0)
  /** 最新在上，侧栏只取最近 10 条；总数仍在标题里。 */
  const rows = createMemo(() => data.drops().toReversed().slice(0, SIDEBAR_ROWS))
  /** 与摘要块一致的固定高度上限：跟随终端高度但夹在 5..12 行。 */
  const listHeight = createMemo(() => Math.max(5, Math.min(12, Math.floor(props.context.renderer.height / 5))))
  /** 记录少时按内容收缩，避免列表下方留一大片空白把下一个分区顶远。 */
  const visibleHeight = createMemo(() => Math.min(listHeight(), Math.max(1, rows().length)))

  // 只有 hover 时跑两帧；鼠标移出或销毁时清理，避免后台定时器。
  createEffect(() => {
    if (hovered() === undefined) {
      setFrame(0)
      return
    }
    const timer = setInterval(() => setFrame((value) => (value + 1) % 2), 180)
    onCleanup(() => {
      clearInterval(timer)
    })
  })

  /** 输入：无；输出：无；预期：翻转折叠状态并写回设置。 */
  const toggleFold = (): void => {
    void props.updateSettings((draft) => {
      draft.cacheDropsExpanded = !draft.cacheDropsExpanded
    })
  }

  return (
    <Show when={props.settings.cacheDropsEnabled && props.settings.showCacheDrops}>
      <box width="100%" flexDirection="column">
        <box flexDirection="row" height={1} onMouseDown={toggleFold}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.base}>{props.settings.cacheDropsExpanded ? "▼" : "▶"}</text>
            <text fg={theme.text.base}>
              <b>{copy().drops.title}</b>
            </text>
            <text fg={theme.text.muted}>{`(${data.drops().length.toString()})`}</text>
          </box>
        </box>
        <Show when={props.settings.cacheDropsExpanded}>
          <Show
            when={rows().length > 0}
            fallback={<text fg={theme.text.muted}>{copy().drops.empty}</text>}
          >
            {/* 固定高度的滚动列表：记录再多也不会把整个侧栏撑长，也不会只显示前几条。 */}
            <scrollbox height={visibleHeight()} width="100%" scrollY={true} flexShrink={0}>
              <box flexDirection="column" width="100%">
                <For each={rows()}>
                  {(drop) => (
                    <box
                      flexDirection="row"
                      height={1}
                      gap={1}
                      onMouseOver={() => {
                        setHovered(drop.messageID)
                      }}
                      onMouseOut={() => {
                        setHovered((current) => (current === drop.messageID ? undefined : current))
                      }}
                      onMouseUp={() => {
                        props.onOpen(drop.messageID)
                      }}
                    >
                      <text width={2} fg={theme.text.feedback.error.base}>
                        {hovered() === drop.messageID ? (frame() === 0 ? "▸ " : " ▸") : "  "}
                      </text>
                      <text fg={theme.text.muted} width={5} flexShrink={0}>
                        {timeLabel(drop.at)}
                      </text>
                      <text fg={theme.text.feedback.error.base} width={9} flexShrink={0} textAlign="right">
                        {`-${drop.dropPp.toFixed(1)}pp`}
                      </text>
                      <text fg={theme.text.muted} width={8} flexShrink={0}>
                        {copy().drops.kind[drop.kind ?? "unknown"]}
                      </text>
                      <text fg={theme.text.muted} width={3} flexShrink={0} textAlign="center">
                        {copy().drops.causeIcon[drop.cause]}
                      </text>
                      <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                        {segmentLabel(drop.breakPoint)}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </scrollbox>
            <Show when={data.drops().length > SIDEBAR_ROWS}>
              <text fg={theme.text.muted} wrapMode="word">
                {copy().drops.more(data.drops().length - SIDEBAR_ROWS)}
              </text>
            </Show>
          </Show>
        </Show>
      </box>
    </Show>
  )
}
