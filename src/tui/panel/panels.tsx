import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { formatTokens } from "../../shared/format.ts"
import { effectiveLimit, localeArgument, type Settings } from "../../shared/settings.ts"
import { scaleCategories } from "../../shared/stats.ts"
import { FALLBACK_ERROR, FALLBACK_SUCCESS, FALLBACK_WARNING, mix, toHex, toRgb } from "../chart/color.ts"
import type { UpdateSettings } from "../types.ts"
import { CacheSection } from "./cache.tsx"
import { usePanelData } from "./data-scoped.ts"
import { SummarySection } from "./summaries.tsx"

/**
 * 输入：该分类占上下文总量的百分比 + 主题。
 * 输出：0%-50%-100% 依次绿-黄-红的连续插值。
 * 预期：每个百分比都有独立颜色；主题色不可解析时回退到内置色。
 */
function occupancyColor(pct: number, theme: Context["theme"]): string {
  const green = toRgb(theme.text.feedback.success.base) ?? FALLBACK_SUCCESS
  const yellow = toRgb(theme.text.feedback.warning.base) ?? FALLBACK_WARNING
  const red = toRgb(theme.text.feedback.error.base) ?? FALLBACK_ERROR
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

/** 侧栏上下文分区；缓存与摘要各自返回独立 slot 组件。 */
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
    scope: "context",
  })

  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))

  /** 最后一条 assistant；模型上限和 usage 分开取，避免 provider 没给 usage 时连上限都丢。 */
  const lastAssistant = createMemo(() => {
    const list = messages()
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.type === "assistant") return message
    }
    return undefined
  })

  /** 模型原生窗口：从最后一条 assistant 的模型解析。 */
  const nativeLimit = createMemo(() => {
    const message = lastAssistant()
    if (message === undefined) return 0
    const model = props.context.data.location.model
      .list(session()?.location)
      ?.find((item) => item.providerID === message.model.providerID && item.id === message.model.id)
    return model?.limit.context ?? 0
  })

  /** 真实 prompt token：只算 input + cache，output/reasoning 不属于本轮输入。 */
  const realUsed = createMemo(() => {
    const tokens = lastAssistant()?.tokens
    if (tokens === undefined) return undefined
    const used = tokens.input + tokens.cache.read + tokens.cache.write
    return used > 0 ? used : undefined
  })

  /** 上下文占用：真实 usage 优先，缺失时才回退到服务端估算。 */
  const contextTokens = createMemo(() => realUsed() ?? data.stats()?.estimatedTotal ?? 0)

  /** 实际生效的上下文上限：自定义优先，否则模型原生。 */
  const limit = createMemo(() => effectiveLimit(props.settings, nativeLimit()))

  /** 仅当用户自定义上限时展示百分比（auto 时内置区块已经显示了）。 */
  const percent = createMemo(() => {
    const max = limit()
    if (max === undefined || max <= 0) return undefined
    return Math.round((contextTokens() / max) * 100)
  })

  const rows = createMemo(() => {
    const value = data.stats()
    if (value === undefined || value.estimatedTotal <= 0) return []
    return scaleCategories(value, contextTokens()).filter((row) => row.value > 0)
  })

  const toggleExpanded = (): void => {
    void props.updateSettings((draft) => {
      draft.expanded = !draft.expanded
    })
  }

  return (
    <Show when={props.settings.enabled}>
      <box width="100%" flexDirection="column">
        <box flexDirection="row" height={1} onMouseDown={toggleExpanded}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.base}>{props.settings.expanded ? "▼" : "▶"}</text>
            <text fg={theme.text.base}>
              <b>{copy().title}</b>
            </text>
            <Show when={props.settings.contextLimit !== "auto" && percent() !== undefined}>
              <text fg={occupancyColor(percent() ?? 0, theme)}>
                {`(${(percent() ?? 0).toString()}%)`}
              </text>
            </Show>
          </box>
        </box>
        <Show when={data.terminal()}>
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            {`⚠ ${copy().terminal}`}
          </text>
        </Show>
        <Show when={props.settings.expanded}>
          <box flexDirection="column" width="100%" paddingLeft={2}>
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
          </box>
        </Show>
      </box>
    </Show>
  )
}

/**
 * 输入：TUI 上下文 + 会话 + 设置 + 数据范围。
 * 输出：主题、文案、该范围的面板数据。
 * 预期：缓存与摘要分区共用同一套准备逻辑，只有 Section 组件不同。
 */
function usePanelSection(
  props: {
    readonly context: Context
    readonly sessionID: string
    readonly settings: Settings
  },
  scope: "cache" | "summaries",
) {
  const theme = props.context.theme
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))
  const data = usePanelData({
    context: props.context,
    sessionID: props.sessionID,
    settings: () => props.settings,
    scope,
  })
  return { theme, copy, data }
}

/** 输入：TUI 上下文 + 设置；输出：缓存记录分区。预期：独立 slot，空行交给宿主 gap。 */
export function CachePanel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const { theme, copy, data } = usePanelSection(props, "cache")
  return (
    <Show when={props.settings.enabled}>
      <CacheSection
        theme={theme}
        copy={copy()}
        settings={props.settings}
        updateSettings={props.updateSettings}
        samples={data.cache()}
      />
    </Show>
  )
}

/** 输入：TUI 上下文 + 设置；输出：摘要块分区。预期：独立 slot，空行交给宿主 gap。 */
export function SummaryPanel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const { theme, copy, data } = usePanelSection(props, "summaries")
  return (
    <Show when={props.settings.enabled}>
      <SummarySection
        context={props.context}
        theme={theme}
        copy={copy()}
        settings={props.settings}
        updateSettings={props.updateSettings}
        blocks={data.blocks()}
      />
    </Show>
  )
}
