import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { formatHitRate } from "../../shared/cache.ts"
import type { CacheDrop } from "../../shared/cache-drops.ts"
import { formatTokens } from "../../shared/format.ts"
import { localeArgument, type Settings } from "../../shared/settings.ts"
import { usePanelData } from "./data-scoped.ts"
import { segmentLabel, splitExcerpt, timeLabel } from "./drops-format.ts"

/** 输入：跌幅；输出：火花线上的字符。预期：跌幅越大越实心。 */
function barGlyph(dropPp: number): string {
  const glyphs = "▁▂▃▄▅▆▇█"
  const ratio = Math.min(1, Math.max(0, dropPp / 100))
  return glyphs[Math.min(glyphs.length - 1, Math.floor(ratio * glyphs.length))] ?? "▁"
}

/** 输入：跌幅；输出：主题色 token。预期：≥30pp 用错误色，其余用警告色。 */
function barColor(dropPp: number, theme: Context["theme"]): Context["theme"]["text"]["base"] {
  return dropPp >= 30 ? theme.text.feedback.error.base : theme.text.feedback.warning.base
}

/** 输入：标签 + 拆开的摘录 + 高亮色；输出：一行「标签 + 公共前缀 + 差异 + 公共后缀」。 */
function ExcerptLine(props: {
  readonly theme: Context["theme"]
  readonly label: string
  readonly prefix: string
  readonly diff: string
  readonly suffix: string
  readonly color: Context["theme"]["text"]["base"]
}) {
  return (
    <box flexDirection="row" height={1}>
      <text fg={props.theme.text.muted} width={6}>
        {props.label}
      </text>
      <text fg={props.theme.text.base}>{props.prefix}</text>
      <text fg={props.color}>{props.diff}</text>
      <text fg={props.theme.text.base}>{props.suffix}</text>
    </box>
  )
}

/**
 * 输入：TUI 上下文 + 会话 + 设置 + 当前选中的记录 + 选中回调。
 * 输出：全宽「缓存突变」面板（火花线 + 列表 + 差异详情）。
 * 预期：只显示本会话的记录；空态给出明确提示；窄屏时详情也保持单列。
 */
export function DropsView(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly selected: string | undefined
  readonly onSelect: (messageID: string) => void
}) {
  const theme = props.context.theme
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))
  const data = usePanelData({
    context: props.context,
    sessionID: props.sessionID,
    settings: () => props.settings,
    scope: "drops",
  })

  const drops = createMemo(() => data.drops().toReversed())
  const active = createMemo(() => {
    const list = drops()
    if (list.length === 0) return undefined
    return list.find((drop) => drop.messageID === props.selected) ?? list[0]
  })
  const listHeight = createMemo(() => Math.max(4, Math.min(10, Math.floor(props.context.renderer.height / 5))))
  const excerpt = createMemo(() => {
    const drop = active()
    if (drop?.breakPoint === undefined) return undefined
    return splitExcerpt(drop.breakPoint)
  })

  return (
    <box width="100%" flexDirection="column">
      <box flexDirection="row" height={1} gap={1}>
        <text fg={theme.text.base}>
          <b>{copy().drops.panelTitle}</b>
        </text>
        <text fg={theme.text.muted}>
          {copy().drops.hint(props.settings.cacheDropsThreshold, props.settings.cacheDropsMaxRecords)}
        </text>
      </box>

      <Show
        when={drops().length > 0}
        fallback={<text fg={theme.text.muted}>{copy().drops.empty}</text>}
      >
        <box flexDirection="row" height={1}>
          <For each={drops()}>
            {(drop) => <text fg={barColor(drop.dropPp, theme)}>{barGlyph(drop.dropPp)}</text>}
          </For>
        </box>

        <scrollbox height={listHeight()} scrollY={true} width="100%">
          <For each={drops()}>
            {(drop) => {
              const selected = active()?.messageID === drop.messageID
              return (
                <box
                  flexDirection="row"
                  height={1}
                  gap={1}
                  {...(selected ? { backgroundColor: theme.background.raised.high } : {})}
                  onMouseDown={() => {
                    props.onSelect(drop.messageID)
                  }}
                >
                  <text fg={selected ? theme.text.feedback.success.base : theme.text.muted}>
                    {selected ? "▶" : " "}
                  </text>
                  <text fg={theme.text.muted}>{timeLabel(drop.at)}</text>
                  <text fg={barColor(drop.dropPp, theme)}>{`-${drop.dropPp.toFixed(1)}pp`}</text>
                  <text fg={theme.text.muted}>{copy().drops.cause[drop.cause]}</text>
                  <text fg={theme.text.base}>{segmentLabel(drop.breakPoint)}</text>
                </box>
              )
            }}
          </For>
        </scrollbox>

        <Show when={active()}>
          {(drop) => <DropDetail theme={theme} copy={copy()} drop={drop()} excerpt={excerpt()} />}
        </Show>
      </Show>
    </box>
  )
}

/** 输入：单条记录 + 文案；输出：上条/本条命中率、断点与两侧原文差异。 */
function DropDetail(props: {
  readonly theme: Context["theme"]
  readonly copy: ReturnType<typeof resolveMessages>
  readonly drop: CacheDrop
  readonly excerpt: ReturnType<typeof splitExcerpt> | undefined
}) {
  return (
    <box flexDirection="column" width="100%" paddingTop={1}>
      <box flexDirection="row" height={1} gap={1}>
        <text fg={props.theme.text.muted}>{props.copy.drops.cause[props.drop.cause]}</text>
        <Show when={props.drop.breakPoint}>
          <text fg={props.theme.text.base}>{segmentLabel(props.drop.breakPoint)}</text>
        </Show>
      </box>
      <box flexDirection="row" height={1} gap={1}>
        <text fg={props.theme.text.muted}>{props.copy.drops.prev}</text>
        <text fg={props.theme.text.base}>{formatTokens(props.drop.prevPrompt)}</text>
        <text fg={props.theme.text.muted}>{`${formatHitRate(props.drop.prevHitRate)}%`}</text>
        <text fg={props.theme.text.muted}>{props.copy.drops.cur}</text>
        <text fg={props.theme.text.base}>{formatTokens(props.drop.prompt)}</text>
        <text fg={props.theme.text.feedback.error.base}>{`${formatHitRate(props.drop.hitRate)}%`}</text>
      </box>
      <Show when={props.excerpt}>
        {(split) => (
          <>
            <ExcerptLine
              theme={props.theme}
              label={props.copy.drops.was}
              prefix={split().prefix}
              diff={split().was}
              suffix={split().suffix}
              color={props.theme.text.feedback.error.base}
            />
            <ExcerptLine
              theme={props.theme}
              label={props.copy.drops.now}
              prefix={split().prefix}
              diff={split().now}
              suffix={split().suffix}
              color={props.theme.text.feedback.success.base}
            />
          </>
        )}
      </Show>
    </box>
  )
}
