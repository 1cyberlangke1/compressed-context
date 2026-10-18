import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { formatTokens } from "../format.ts"
import { resolveMessages } from "../i18n/index.ts"
import { effectiveLimit, localeArgument, type Settings } from "../settings.ts"
import { parseStats, scaleCategories, STATS_KEY, type CategoryKey, type ContextStats } from "../stats.ts"
import type { UpdateSettings } from "./types.ts"

/** 输入：分类 key；输出：该分类柱子的颜色；预期：跟随主题 token。 */
function categoryColor(key: CategoryKey, theme: Context["theme"]) {
  switch (key) {
    case "system":
      return theme.text.feedback.info.base
    case "tools":
      return theme.hue.accent[500]
    case "tool":
      return theme.text.feedback.warning.base
    case "text":
      return theme.text.base
    case "summaries":
      return theme.hue.interactive[500]
    case "media":
      return theme.text.muted
  }
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
        <Show when={props.settings.expanded}>
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" height={1} gap={1}>
                <text fg={theme.text.muted} width={10} flexShrink={0}>
                  {copy().labels[row.key]}
                </text>
                <box flexGrow={1} height={1} backgroundColor={theme.background.raised.high}>
                  <box height={1} width={percentWidth(row.pct)} backgroundColor={categoryColor(row.key, theme)} />
                </box>
                <text fg={theme.text.muted} width={4} flexShrink={0} textAlign="right">
                  {`${row.pct.toString()}%`}
                </text>
                <text fg={theme.text.muted} width={7} flexShrink={0} textAlign="right">
                  {`${formatTokens(row.value)}${copy().approximate}`}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}
