import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, Show } from "solid-js"

import { formatTokens } from "../format.ts"
import { resolveMessages, type Messages } from "../i18n/index.ts"
import {
  isContextLimit,
  localeArgument,
  parseTokenLimit,
  sanitizeLimitInput,
  type ContextLimit,
  type LocaleSetting,
  type Settings,
} from "../settings.ts"
import type { UpdateSettings } from "./types.ts"

/** 可选上限预设；菜单里只出现合法值。 */
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
] as const

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

/**
 * 输入：TUI 上下文 + 文案 + 初始值 + 确认回调。
 * 输出：自定义上下文上限的输入对话框。
 * 预期：只接受数字 + 结尾 k/m；解析成功才允许回车提交，非法时只提示不写入。
 */
function LimitDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly initial: string
  readonly onConfirm: (value: number) => void
}) {
  const theme = props.context.theme
  const [text, setText] = createSignal(props.initial)
  const parsed = createMemo(() => parseTokenLimit(text()))

  const confirm = (): void => {
    const value = parsed()
    if (value === undefined) return
    props.onConfirm(value)
    props.context.ui.dialog.clear()
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text.base}>
        <b>{props.copy.settings.limit}</b>
      </text>
      <input
        value={text()}
        placeholder="200k"
        onInput={(value: string) => {
          setText(sanitizeLimitInput(value))
        }}
        onSubmit={confirm}
        ref={(input) => {
          setTimeout(() => {
            if (!input.isDestroyed) input.focus()
          }, 1)
        }}
      />
      <Show
        when={parsed()}
        fallback={<text fg={theme.text.feedback.error.base}>{props.copy.settings.limitInvalid}</text>}
      >
        {(value: () => number) => <text fg={theme.text.muted}>{`= ${formatTokens(value())} tokens`}</text>}
      </Show>
      <text fg={theme.text.muted}>{props.copy.settings.limitHint}</text>
      <text fg={theme.text.muted}>{props.copy.settings.limitHelp}</text>
    </box>
  )
}

/**
 * 输入：TUI 插件上下文 + 设置。
 * 输出：注册 /compressed-context 命令（斜杠 + 命令面板）。
 * 预期：打开设置菜单；所有文案来自语言文件，切换语言后命令会重新注册。
 */
export function SettingsCommand(props: {
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

  const openCustom = (): void => {
    props.context.ui.dialog.show(() => (
      <LimitDialog
        context={props.context}
        copy={copy()}
        initial={props.settings.contextLimit === "auto" ? "" : props.settings.contextLimit.toString()}
        onConfirm={(value) => {
          void props.updateSettings((draft) => {
            draft.contextLimit = value
          })
        }}
      />
    ))
  }

  const openLimit = async (): Promise<boolean> => {
    const picked = await props.context.ui.dialog.select<ContextLimit | "custom">({
      title: copy().settings.limit,
      current: props.settings.contextLimit,
      options: [
        { title: copy().settings.limitAuto, value: "auto" },
        ...PRESET_LIMITS.map((value) => ({ title: formatTokens(value), value })),
        { title: copy().settings.limitCustom, value: "custom" as const },
      ],
    })
    if (picked === undefined) return false
    if (picked === "custom") {
      openCustom()
      return true
    }
    await props.updateSettings((draft) => {
      draft.contextLimit = picked
    })
    return false
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
        { title: copy().settings.limit, value: "limit", footer: limitLabel(props.settings, copy()) },
        { title: copy().settings.language, value: "language", footer: localeLabel(props.settings, copy()) },
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
      const custom = await openLimit()
      // 自定义对话框已经打开时不要再弹主菜单，否则会把它顶掉。
      if (!custom) void openSettings()
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
