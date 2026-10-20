import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { formatTokens } from "../format.ts"
import { resolveMessages } from "../i18n/index.ts"
import { effectiveLimit, localeArgument, type Settings } from "../settings.ts"
import { parseStats, scaleCategories, STATS_KEY, TERMINAL_KEY, type ContextStats } from "../stats.ts"
import type { UpdateSettings } from "./types.ts"

/** 颜色三元组，分量 0-255。 */
type Rgb = readonly [number, number, number]

/** 输入：0-255 分量；输出：两位十六进制。 */
function channel(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0")
}

/** 输入：颜色值；输出：RGB；不是 hex 返回 undefined。 */
function parseHex(value: string): Rgb | undefined {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value.trim())
  const raw = match?.[1]
  if (raw === undefined) return undefined
  if (raw.length === 3 || raw.length === 4) {
    return [
      parseInt(raw.charAt(0).repeat(2), 16),
      parseInt(raw.charAt(1).repeat(2), 16),
      parseInt(raw.charAt(2).repeat(2), 16),
    ]
  }
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ]
}

/** 输入：两个颜色 + 0-1 比例；输出：线性插值后的颜色。 */
function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
    from[2] + (to[2] - from[2]) * ratio,
  ]
}

/** 输入：RGB；输出：hex 字符串。 */
function toHex(rgb: Rgb): string {
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

/** 输入：颜色值（hex 字符串或 OpenTUI RGBA）；输出：RGB。 */
function toRgb(value: unknown): Rgb | undefined {
  if (typeof value === "string") return parseHex(value)
  if (typeof value === "object" && value !== null) {
    const color = value as { readonly r?: unknown; readonly g?: unknown; readonly b?: unknown }
    if (typeof color.r === "number" && typeof color.g === "number" && typeof color.b === "number") {
      // OpenTUI 的 RGBA.r/g/b 是 0-1 归一化值，这里转成 0-255。
      return [color.r * 255, color.g * 255, color.b * 255]
    }
  }
  return undefined
}

/**
 * 输入：该分类占上下文总量的百分比 + 主题。
 * 输出：0%-50%-100% 依次绿-黄-红的连续插值。
 * 预期：每个百分比都有独立颜色；主题色不可解析时回退到内置色。
 */
function occupancyColor(pct: number, theme: Context["theme"]): string {
  const green = toRgb(theme.text.feedback.success.base) ?? [34, 197, 94]
  const yellow = toRgb(theme.text.feedback.warning.base) ?? [234, 179, 8]
  const red = toRgb(theme.text.feedback.error.base) ?? [239, 68, 68]
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
 * 输出：侧栏里的上下文分类面板（可折叠）。
 * 预期：只显示分类条；总量交给内置 Context 区块，避免重复。
 */
export function Panel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const theme = props.context.theme
  const [stats, setStats] = createSignal<ContextStats>()
  const [terminal, setTerminal] = createSignal<string>()
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))

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

  /** 输入：无；输出：无；预期：从服务端重新拉取 session metadata 里的统计。 */
  const refresh = async (): Promise<void> => {
    try {
      const info = await props.context.client.session.get({ sessionID: props.sessionID })
      setStats(parseStats(info.metadata?.[STATS_KEY]))
      const rawTerminal = info.metadata?.[TERMINAL_KEY]
      setTerminal(typeof rawTerminal === "string" ? rawTerminal : undefined)
    } catch {
      // 统计缺失不影响主界面，保持上一次的值
    }
  }

  createEffect(() => {
    void refresh()
  })

  onCleanup(
    props.context.data.on("session.usage.updated", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh()
    }),
  )
  onCleanup(
    props.context.data.on("session.idle", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh()
    }),
  )

  const rows = createMemo(() => {
    const value = stats()
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
        <Show when={terminal()}>
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
        </Show>
      </box>
    </Show>
  )
}
