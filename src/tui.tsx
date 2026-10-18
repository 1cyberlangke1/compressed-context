import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { formatTokens } from "./format.ts"
import { resolveMessages, type Messages } from "./i18n/index.ts"
import {
  initialSettings,
  effectiveLimit,
  isContextLimit,
  localeArgument,
  normalizeSettings,
  type ContextLimit,
  type LocaleSetting,
  type Settings,
} from "./settings.ts"
import { parseStats, scaleCategories, STATS_KEY, type CategoryKey, type ContextStats } from "./stats.ts"

type UpdateSettings = (mutation: (draft: Settings) => void) => Promise<void>

/**
 * 输入：分类 key。
 * 输出：该分类柱子的颜色（主题 token）。
 * 预期：每个分类一种颜色，切换主题时自动跟随。
 */
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
 * 预期：先转成字符串再断言——模板里直接插数字会被 lint 规则拦住，
 *       而 OpenTUI 只接受 `${number}%` 这种字面量类型。
 */
function percentWidth(value: number): `${number}%` {
  const clamped = Math.min(100, Math.max(0, value))
  return `${clamped.toString()}%` as `${number}%`
}

/** 输入：设置；输出：当前语言标签；预期：用于设置菜单右侧的当前值。 */
function localeLabel(settings: Settings, copy: Messages): string {
  if (settings.locale === "auto") return copy.settings.auto
  if (settings.locale === "zh") return copy.languages.zh
  return copy.languages.en
}

/** 输入：设置；输出：当前上下文上限标签；预期：auto 显示「模型原生」。 */
function limitLabel(settings: Settings, copy: Messages): string {
  const value: unknown = settings.contextLimit
  if (!isContextLimit(value) || value === "auto") return copy.settings.limitAuto
  return formatTokens(value)
}

/** 可选上限预设；菜单里只出现合法值，不存在非法输入。 */
const PRESET_LIMITS = [
  32_000,
  64_000,
  100_000,
  128_000,
  200_000,
  256_000,
  300_000,
  400_000,
  512_000,
  768_000,
  1_000_000,
  2_000_000,
] as const

/**
 * 输入：TUI 插件上下文 + sessionID + 设置。
 * 输出：侧栏里的上下文分类面板（可折叠）。
 * 预期：只显示分类条；总量交给内置 Context 区块，避免重复。
 */
function ContextBlock(props: {
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

/**
 * 输入：TUI 插件上下文 + 设置。
 * 输出：注册 /compressed-context 命令（斜杠 + 命令面板）。
 * 预期：打开设置菜单；所有文案来自语言文件，切换语言后命令会重新注册。
 */
function Commands(props: {
  readonly context: Context
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))

  const openLocale = async (): Promise<void> => {
    const picked = await props.context.ui.dialog.select<LocaleSetting>({
      title: copy().settings.language,
      current: props.settings.locale,
      options: [
        { title: copy().settings.auto, value: "auto" },
        { title: copy().languages.zh, value: "zh" },
        { title: copy().languages.en, value: "en" },
      ],
    })
    if (picked === undefined) return
    await props.updateSettings((draft) => {
      draft.locale = picked
    })
  }

  const openLimit = async (): Promise<void> => {
    const picked = await props.context.ui.dialog.select<ContextLimit>({
      title: copy().settings.limit,
      current: props.settings.contextLimit,
      options: [
        { title: copy().settings.limitAuto, value: "auto" },
        ...PRESET_LIMITS.map((value) => ({ title: formatTokens(value), value })),
      ],
    })
    if (picked === undefined) return
    await props.updateSettings((draft) => {
      draft.contextLimit = picked
    })
  }

  const openSettings = async (): Promise<void> => {
    const picked = await props.context.ui.dialog.select<string>({
      title: copy().settings.title,
      options: [
        {
          title: copy().settings.show,
          value: "show",
          footer: props.settings.enabled ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.limit,
          value: "limit",
          footer: limitLabel(props.settings, copy()),
        },
        {
          title: copy().settings.language,
          value: "language",
          footer: localeLabel(props.settings, copy()),
        },
        { title: copy().settings.close, value: "close" },
      ],
    })
    if (picked === "show") {
      await props.updateSettings((draft) => {
        draft.enabled = !draft.enabled
      })
      void openSettings()
      return
    }
    if (picked === "limit") {
      await openLimit()
      void openSettings()
      return
    }
    if (picked === "language") {
      await openLocale()
      void openSettings()
    }
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "compressed-context.settings",
        title: copy().command.title,
        description: copy().command.description,
        group: "Plugins",
        slash: { name: "compressed-context" },
        palette: true,
        run() {
          void openSettings()
        },
      },
    ],
  }))

  return null
}

export default Plugin.define({
  id: "compressed-context.tui",

  /**
   * 输入：TUI 插件上下文（含插件 options）。
   * 输出：侧栏面板 + /compressed-context 设置命令。
   * 预期：设置存在 TUI storage 里；options 只作为首次默认值。
   */
  setup(context) {
    const [settings, updateSettings] = context.storage.store<Settings>("settings", {
      initial: initialSettings(context.options),
    })

    // 旧版本存下来的设置可能缺字段（例如没有 contextLimit），启动时补齐并写回。
    const normalized = normalizeSettings({
      enabled: settings.enabled,
      expanded: settings.expanded,
      locale: settings.locale,
      contextLimit: settings.contextLimit,
    })
    if (
      settings.enabled !== normalized.enabled ||
      settings.expanded !== normalized.expanded ||
      settings.locale !== normalized.locale ||
      settings.contextLimit !== normalized.contextLimit
    ) {
      void updateSettings((draft) => {
        Object.assign(draft, normalized)
      })
    }

    const disposeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <ContextBlock
          context={context}
          sessionID={input.sessionID}
          settings={settings}
          updateSettings={updateSettings}
        />
      ),
    })

    const disposeCommands = context.ui.slot({
      append: "app",
      render: () => <Commands context={context} settings={settings} updateSettings={updateSettings} />,
    })

    return () => {
      disposeSidebar()
      disposeCommands()
    }
  },
})
