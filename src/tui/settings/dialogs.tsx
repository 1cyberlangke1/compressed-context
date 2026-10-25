import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, Show, type ParentProps } from "solid-js"

import { formatTokens } from "../../shared/format.ts"
import type { Messages } from "../../i18n/index.ts"
import {
  MAX_TRIGGER_PERCENT,
  MIN_TRIGGER_PERCENT,
  parseSummaryPercent,
  parseTokenCount,
} from "../../shared/settings.ts"
import { percentLabel } from "./options.ts"

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
 * 输入：TUI 上下文 + 文案 + 解析/预览/提示 + 确认回调。
 * 输出：单行输入对话框；Token/Percent/Threshold 共用。
 * 预期：只接受 parse 返回数字的输入；非法时显示 invalid，不写入。
 */
function DialogInput(props: {
  readonly context: Context
  readonly copy: Messages
  readonly title: string
  readonly hint: string
  readonly invalid: string
  readonly placeholder: string
  readonly initial: string
  readonly parse: (text: string) => number | undefined
  readonly preview: (value: number) => string
  readonly extra?: string
  readonly onConfirm: (value: number) => void
}) {
  const theme = props.context.theme
  const [text, setText] = createSignal(props.initial)
  const parsed = createMemo(() => props.parse(text()))
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
    <DialogFrame context={props.context} title={props.title} submit={props.copy.settings.submit}>
      <textarea
        height={1}
        wrapMode="none"
        initialValue={props.initial}
        placeholder={props.placeholder}
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
        when={parsed() !== undefined}
        fallback={<text fg={theme.text.feedback.error.base}>{props.invalid}</text>}
      >
        <text fg={theme.text.muted}>{props.preview(parsed() ?? 0)}</text>
      </Show>
      <Show when={props.extra !== undefined}>
        <text fg={theme.text.muted}>{props.extra}</text>
      </Show>
      <text fg={theme.text.muted}>{props.hint}</text>
    </DialogFrame>
  )
}

/** 输入：TUI 上下文 + 文案 + 标题/提示 + 初始值 + 确认回调；输出：非负整数对话框。
 *  预期：块数这类计数不设上下限，填多少就是多少；空或非整数才算非法。 */
export function CountDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly title: string
  readonly hint: string
  readonly invalid: string
  readonly initial: string
  readonly onConfirm: (value: number) => void
}) {
  return (
    <DialogInput
      context={props.context}
      copy={props.copy}
      title={props.title}
      hint={props.hint}
      invalid={props.invalid}
      placeholder="0"
      initial={props.initial}
      parse={(text) => {
        const trimmed = text.trim()
        if (!/^\d+$/.test(trimmed)) return undefined
        const value = Number(trimmed)
        return Number.isSafeInteger(value) ? value : undefined
      }}
      preview={(value) => value.toString()}
      onConfirm={props.onConfirm}
    />
  )
}

/** 输入：TUI 上下文 + 文案 + 标题/提示 + 初始值 + 合法范围 + 确认回调。 */
export function TokenDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly title: string
  readonly hint: string
  readonly invalid: string
  readonly placeholder: string
  readonly initial: string
  readonly min: number
  readonly max: number
  readonly allowZero?: boolean
  readonly onConfirm: (value: number) => void
}) {
  return (
    <DialogInput
      context={props.context}
      copy={props.copy}
      title={props.title}
      hint={props.hint}
      invalid={props.invalid}
      placeholder={props.placeholder}
      initial={props.initial}
      parse={(text) => {
        if (props.allowZero === true && text.trim() === "0") return 0
        return parseTokenCount(text, props.min, props.max)
      }}
      preview={(value) =>
        value === 0 ? props.copy.settings.off : props.copy.settings.limitPreview(formatTokens(value))
      }
      onConfirm={props.onConfirm}
    />
  )
}

/** 输入：TUI 上下文 + 文案 + 初始百分比 + 窗口 + 允许范围 + 确认回调。 */
export function PercentDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly title: string
  readonly hint: string
  readonly invalid: string
  readonly initial: number
  readonly windowTokens: number | undefined
  readonly minPercent: number
  readonly maxPercent: number
  readonly onConfirm: (value: number) => void
}) {
  return (
    <DialogInput
      context={props.context}
      copy={props.copy}
      title={props.title}
      hint={props.hint}
      invalid={props.invalid}
      placeholder="10%"
      initial={`${props.initial.toString()}%`}
      parse={(text) => {
        const value = parseSummaryPercent(text, props.windowTokens)
        if (value === undefined || value < props.minPercent || value > props.maxPercent) {
          return undefined
        }
        return value
      }}
      preview={(value) => percentLabel(value, props.windowTokens)}
      extra={
        props.windowTokens === undefined
          ? props.copy.settings.windowUnknown
          : props.copy.settings.windowKnown(formatTokens(props.windowTokens))
      }
      onConfirm={props.onConfirm}
    />
  )
}

/** 输入：TUI 上下文 + 文案 + 初始值 + 确认回调。 */
export function ThresholdDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly initial: string
  readonly onConfirm: (value: number) => void
}) {
  return (
    <DialogInput
      context={props.context}
      copy={props.copy}
      title={props.copy.settings.threshold}
      hint={props.copy.settings.thresholdHint}
      invalid={props.copy.settings.thresholdInvalid}
      placeholder="80"
      initial={props.initial}
      parse={(text) => {
        if (!/^\d{1,2}$/.test(text)) return undefined
        const value = Number(text)
        if (value < MIN_TRIGGER_PERCENT || value > MAX_TRIGGER_PERCENT) return undefined
        return value
      }}
      preview={(value) => props.copy.settings.thresholdPreview(value.toString())}
      onConfirm={props.onConfirm}
    />
  )
}
