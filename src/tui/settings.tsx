import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, Show, type ParentProps } from "solid-js"

import { formatTokens } from "../format.ts"
import { resolveMessages, type Messages } from "../i18n/index.ts"
import { ContextRpc } from "../rpc.ts"
import {
  isContextLimit,
  localeArgument,
  MAX_TRIGGER_PERCENT,
  MIN_TRIGGER_PERCENT,
  parseTokenLimit,
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
 * 输入：TUI 上下文 + 标题 + 内容。
 * 输出：与原生对话框一致的外框（左右 3 格内边距、标题栏、底部操作行）。
 * 预期：标题在左、esc 在右；内容区与底部操作行各留一空行。
 */
function DialogFrame(
  props: ParentProps<{ readonly context: Context; readonly title: string; readonly submit: string }>,
) {
  const theme = props.context.theme
  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme.text.base}>
          <b>{props.title}</b>
        </text>
        <text
          fg={theme.text.muted}
          onMouseUp={() => {
            props.context.ui.dialog.clear()
          }}
        >
          esc
        </text>
      </box>
      <box gap={1}>{props.children}</box>
      <text fg={theme.text.muted}>{props.submit} enter</text>
    </box>
  )
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
  let area: { plainText: string } | undefined

  const confirm = (): void => {
    const value = parsed()
    if (value === undefined) return
    props.onConfirm(value)
    props.context.ui.dialog.clear()
  }

  // 原生 DialogPrompt 用模态层接管回车；这里同样注册，避免 textarea 插入换行。
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [{ bind: "enter", title: "Submit", group: "Dialog", run: confirm }],
  }))

  return (
    <DialogFrame context={props.context} title={props.copy.settings.limit} submit={props.copy.settings.submit}>
      <textarea
        height={1}
        wrapMode="none"
        initialValue={props.initial}
        placeholder={props.copy.settings.limitPlaceholder}
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.base}
        onContentChange={() => setText(area?.plainText ?? "")}
        ref={(input) => {
          area = input
          setTimeout(() => {
            if (!input.isDestroyed) input.focus()
          }, 1)
        }}
      />
      <Show
        when={parsed()}
        fallback={<text fg={theme.text.feedback.error.base}>{props.copy.settings.limitInvalid}</text>}
      >
        {(value: () => number) => (
          <text fg={theme.text.muted}>{props.copy.settings.limitPreview(formatTokens(value()))}</text>
        )}
      </Show>
      <text fg={theme.text.muted}>{props.copy.settings.limitHint}</text>
    </DialogFrame>
  )
}

/**
 * 输入：TUI 上下文 + 文案 + 初始值 + 确认回调。
 * 输出：压缩阈值的输入对话框。
 * 预期：只接受 60 ~ 95 的整数；解析失败回车不生效。
 */
function ThresholdDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly initial: string
  readonly onConfirm: (value: number) => void
}) {
  const theme = props.context.theme
  const [text, setText] = createSignal(props.initial)
  const parsed = createMemo(() => {
    if (!/^\d{1,2}$/.test(text())) return undefined
    const value = Number(text())
    if (value < MIN_TRIGGER_PERCENT || value > MAX_TRIGGER_PERCENT) return undefined
    return value
  })
  let area: { plainText: string } | undefined

  const confirm = (): void => {
    const value = parsed()
    if (value === undefined) return
    props.onConfirm(value)
    props.context.ui.dialog.clear()
  }

  // 原生 DialogPrompt 用模态层接管回车；这里同样注册，避免 textarea 插入换行。
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [{ bind: "enter", title: "Submit", group: "Dialog", run: confirm }],
  }))

  return (
    <DialogFrame context={props.context} title={props.copy.settings.threshold} submit={props.copy.settings.submit}>
      <textarea
        height={1}
        wrapMode="none"
        initialValue={props.initial}
        placeholder="80"
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.base}
        onContentChange={() => setText(area?.plainText ?? "")}
        ref={(input) => {
          area = input
          setTimeout(() => {
            if (!input.isDestroyed) input.focus()
          }, 1)
        }}
      />
      <Show
        when={parsed()}
        fallback={<text fg={theme.text.feedback.error.base}>{props.copy.settings.thresholdInvalid}</text>}
      >
        {(value: () => number) => (
          <text fg={theme.text.muted}>{props.copy.settings.thresholdPreview(value().toString())}</text>
        )}
      </Show>
      <text fg={theme.text.muted}>{props.copy.settings.thresholdHint}</text>
    </DialogFrame>
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

  // 设置变化时推给服务端；服务端插件未加载时静默忽略。
  createEffect(() => {
    const payload = {
      contextLimit: props.settings.contextLimit,
      triggerPercent: props.settings.triggerPercent,
    }
    try {
      // ContextRpc 是 PortableDefinition，具体方法名在类型上退化成索引签名，这里补回调用形状。
      const rpc = props.context.client.rpc(ContextRpc) as unknown as {
        settingsSet(input: { contextLimit: "auto" | number; triggerPercent: number }): Promise<unknown>
      }
      void rpc.settingsSet(payload).catch(() => undefined)
    } catch {
      // server plugin not loaded
    }
  })

  const openThreshold = (): void => {
    props.context.ui.dialog.show(() => (
      <ThresholdDialog
        context={props.context}
        copy={copy()}
        initial={props.settings.triggerPercent.toString()}
        onConfirm={(value) => {
          void props.updateSettings((draft) => {
            draft.triggerPercent = value
          })
        }}
      />
    ))
  }

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
        {
          title: copy().settings.threshold,
          value: "threshold",
          footer: `${props.settings.triggerPercent.toString()}%`,
        },
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
    if (picked === "threshold") {
      openThreshold()
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
        group: copy().command.group,
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
