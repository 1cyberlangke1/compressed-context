import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { formatHitRate } from "../../shared/cache.ts"
import type { CacheDrop, CacheDropSegment } from "../../shared/cache-drops.ts"
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

/** 输入：原始段文本；输出：能直接展示的多行 JSON；不是 JSON 时原样返回。 */
function prettyRequest(text: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(text)
    const pretty = typeof value === "string" ? value : JSON.stringify(value, null, 2)
    return pretty.split(/\r?\n/)
  } catch {
    return text.split(/\r?\n/)
  }
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
 * 输出：全宽「缓存突变」面板（火花线 + 列表 + 原始请求结构 + 断点原文）。
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
  const listHeight = createMemo(() => Math.max(4, Math.min(10, Math.floor(props.context.renderer.height / 6))))
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
                  <text fg={theme.text.muted}>{copy().drops.kind[drop.kind ?? "unknown"]}</text>
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

/** 输入：单条记录 + 文案；输出：请求结构、断点原文与两侧差异。 */
function DropDetail(props: {
  readonly theme: Context["theme"]
  readonly copy: ReturnType<typeof resolveMessages>
  readonly drop: CacheDrop
  readonly excerpt: ReturnType<typeof splitExcerpt> | undefined
}) {
  const lines = createMemo(() => (props.drop.request === undefined ? [] : prettyRequest(props.drop.request.text)))
  const outline = createMemo<readonly CacheDropSegment[]>(() => props.drop.outline ?? [])
  const breakKey = createMemo(() => props.drop.breakPoint?.segment)

  return (
    <box flexDirection="column" width="100%" paddingTop={1}>
      <box flexDirection="row" height={1} gap={1}>
        <text fg={props.theme.text.feedback.success.base}>{props.copy.drops.kind[props.drop.kind ?? "unknown"]}</text>
        <text fg={props.theme.text.muted}>{props.copy.drops.cause[props.drop.cause]}</text>
        <text fg={props.theme.text.base}>{segmentLabel(props.drop.breakPoint)}</text>
      </box>
      <box flexDirection="row" height={1} gap={1}>
        <text fg={props.theme.text.muted}>{props.copy.drops.prev}</text>
        <text fg={props.theme.text.base}>{formatTokens(props.drop.prevPrompt)}</text>
        <text fg={props.theme.text.muted}>{`${formatHitRate(props.drop.prevHitRate)}%`}</text>
        <text fg={props.theme.text.muted}>{props.copy.drops.cur}</text>
        <text fg={props.theme.text.base}>{formatTokens(props.drop.prompt)}</text>
        <text fg={props.theme.text.feedback.error.base}>{`${formatHitRate(props.drop.hitRate)}%`}</text>
      </box>

      <Show when={outline().length > 0}>
        <text fg={props.theme.text.muted}>{props.copy.drops.structure}</text>
        <scrollbox height={Math.min(6, Math.max(2, outline().length))} scrollY={true} width="100%">
          <For each={outline()}>
            {(segment) => (
              <box flexDirection="row" height={1} gap={1}>
                <text fg={segment.key === breakKey() ? props.theme.text.feedback.error.base : props.theme.text.muted}>
                  {segment.key === breakKey() ? "▶" : " "}
                </text>
                <text fg={segment.key === breakKey() ? props.theme.text.base : props.theme.text.muted}>
                  {segment.key}
                </text>
                <text fg={props.theme.text.muted}>{props.copy.drops.chars(segment.chars.toLocaleString())}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>

      <Show when={props.drop.request} fallback={<text fg={props.theme.text.muted}>{props.copy.drops.noRequest}</text>}>
        {(request) => (
          <>
            <box flexDirection="row" height={1} gap={1}>
              <text fg={props.theme.text.muted}>{props.copy.drops.request}</text>
              <text fg={props.theme.text.base}>{request().segment}</text>
              <Show when={request().truncated}>
                <text fg={props.theme.text.feedback.warning.base}>{props.copy.drops.truncated}</text>
              </Show>
            </box>
            <scrollbox height={Math.min(8, Math.max(2, lines().length))} scrollY={true} width="100%">
              <For each={lines()}>
                {(line) => <text fg={props.theme.text.base}>{line.length === 0 ? " " : line}</text>}
              </For>
            </scrollbox>
          </>
        )}
      </Show>

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
