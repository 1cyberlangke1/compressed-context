import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { formatTokens } from "../../shared/format.ts"
import { effectiveLimit, localeArgument, type Settings } from "../../shared/settings.ts"
import { scaleCategories } from "../../shared/stats.ts"
import { mix, toHex, toRgb, type Rgb } from "../chart/color.ts"
import type { UpdateSettings } from "../types.ts"
import { CacheSection } from "./cache.tsx"
import { usePanelData } from "./data.ts"
import { SummarySection } from "./summaries.tsx"

/**
 * 输入：该分类占上下文总量的百分比 + 主题。
 * 输出：0%-50%-100% 依次绿-黄-红的连续插值。
 * 预期：每个百分比都有独立颜色；主题色不可解析时回退到内置色。
 */
function occupancyColor(pct: number, theme: Context["theme"]): string {
  const green = toRgb(theme.text.feedback.success.base) ?? ([34, 197, 94] as Rgb)
  const yellow = toRgb(theme.text.feedback.warning.base) ?? ([234, 179, 8] as Rgb)
  const red = toRgb(theme.text.feedback.error.base) ?? ([239, 68, 68] as Rgb)
  const ratio = Math.min(1, Math.max(0, pct / 100))
  if (ratio <= 0.5) return toHex(mix(green, yellow, ratio * 2))
  return toHex(mix(yellow, red, (ratio - 0.5) * 2))
}

/**
 * 输入：0-100 的百分比。
 * 输出：OpenTUI 的百分比宽度类型 `${number}%`。
 * 预期：先转字符串再断言——模板里直接插数字会被 lint 规则拦住，
 *       而 OpenTUI 只接受 `${number}%` 这种字面量类型。
 */
function percentWidth(value: number): `${number}%` {
  const clamped = Math.min(100, Math.max(0, value))
  return `${clamped.toString()}%` as `${number}%`
}

/**
 * 输入：TUI 上下文 + sessionID + 设置。
 * 输出：侧栏里的上下文分类面板（可折叠），外加缓存命中与摘要块。
 * 预期：分类条总量交给内置 Context 区块；缓存历史由服务端持久化，TUI 只读。
 */
export function Panel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const theme = props.context.theme
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))
  const data = usePanelData({
    context: props.context,
    sessionID: props.sessionID,
    settings: () => props.settings,
  })

  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))

  /** 最后一条带 usage 的 assistant 消息；口径与内置 Context 区块一致。 */
  const usage = createMemo(() => {
    const list = messages()
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.type !== "assistant" || message.tokens === undefined) continue
      const tokens =
        message.tokens.input +
        message.tokens.output +
        message.tokens.reasoning +
        message.tokens.cache.read +
        message.tokens.cache.write
      if (tokens <= 0) continue
      const model = props.context.data.location.model
        .list(session()?.location)
        ?.find((item) => item.providerID === message.model.providerID && item.id === message.model.id)
      return { used: tokens, nativeLimit: model?.limit.context ?? 0 }
    }
    return undefined
  })

  /** 实际生效的上下文上限：自定义优先，否则模型原生。 */
  const limit = createMemo(() => {
    const value = usage()
    if (value === undefined) return undefined
    return effectiveLimit(props.settings, value.nativeLimit)
  })

  /** 仅当用户自定义上限时展示百分比（auto 时内置区块已经显示了）。 */
  const percent = createMemo(() => {
    const value = usage()
    const max = limit()
    if (value === undefined || max === undefined || max <= 0) return undefined
    return Math.round((value.used / max) * 100)
  })

  const rows = createMemo(() => {
    const value = data.stats()
    if (value === undefined || value.estimatedTotal <= 0) return []
    return scaleCategories(value, usage()?.used ?? 0).filter((row) => row.value > 0)
  })

  const toggleExpanded = (): void => {
    void props.updateSettings((draft) => {
      draft.expanded = !draft.expanded
    })
  }

  return (
    <Show when={props.settings.enabled}>
      <box width="100%" flexDirection="column">
        <box flexDirection="row" height={1} justifyContent="space-between" onMouseDown={toggleExpanded}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.base}>{props.settings.expanded ? "▼" : "▶"}</text>
            <text fg={theme.text.base}>
              <b>{copy().title}</b>
            </text>
          </box>
          <Show when={props.settings.contextLimit !== "auto" && percent() !== undefined}>
            <text fg={theme.text.muted}>{`${(percent() ?? 0).toString()}%`}</text>
          </Show>
        </box>
        <Show when={data.terminal()}>
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            {`⚠ ${copy().terminal}`}
          </text>
        </Show>
        <Show when={props.settings.expanded}>
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" height={1} gap={1}>
                <text fg={theme.text.muted} width={10} flexShrink={0}>
                  {copy().labels[row.key]}
                </text>
                <box flexGrow={1} height={1} backgroundColor={theme.background.raised.high}>
                  <box height={1} width={percentWidth(row.pct)} backgroundColor={occupancyColor(row.pct, theme)} />
                </box>
                <text fg={theme.text.muted} width={4} flexShrink={0} textAlign="right">
                  {`${row.pct.toString()}%`}
                </text>
                <text fg={theme.text.muted} width={7} flexShrink={0} textAlign="right">
                  {`${copy().approximate}${formatTokens(row.value)}`}
                </text>
              </box>
            )}
          </For>

          <CacheSection
            theme={theme}
            copy={copy()}
            settings={props.settings}
            updateSettings={props.updateSettings}
            samples={data.cache()}
          />
          <SummarySection
            theme={theme}
            copy={copy()}
            settings={props.settings}
            updateSettings={props.updateSettings}
            blocks={data.blocks()}
          />
        </Show>
      </box>
    </Show>
  )
}
