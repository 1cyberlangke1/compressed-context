import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, Show, type ParentProps } from "solid-js"

import { formatTokens } from "../format.ts"
import type { Messages } from "../i18n/index.ts"
import {
  MAX_TRIGGER_PERCENT,
  MIN_TRIGGER_PERCENT,
  parseSummaryPercent,
  parseTokenCount,
} from "../settings.ts"
import { percentLabel } from "./settings-options.ts"

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
 * 输入：TUI 上下文 + 文案 + 标题/提示 + 初始值 + 合法范围 + 确认回调。
 * 输出：通用 token 输入对话框；上下文上限共用。
 * 预期：只接受数字 + 结尾 k/m；解析成功才允许回车提交，非法时只提示不写入。
 */
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
  readonly onConfirm: (value: number) => void
}) {
  const theme = props.context.theme
  const [text, setText] = createSignal(props.initial)
  const parsed = createMemo(() => parseTokenCount(text(), props.min, props.max))
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
        when={parsed()}
        fallback={<text fg={theme.text.feedback.error.base}>{props.invalid}</text>}
      >
        {(value: () => number) => (
          <text fg={theme.text.muted}>{props.copy.settings.limitPreview(formatTokens(value()))}</text>
        )}
      </Show>
      <text fg={theme.text.muted}>{props.hint}</text>
    </DialogFrame>
  )
}

/**
 * 输入：TUI 上下文 + 文案 + 初始百分比 + 窗口 + 允许范围 + 确认回调。
 * 输出：摘要上限对话框。
 * 预期：接受 `10%` 或 `20k`/`20000`；绝对值按窗口换算；超出范围不提交。
 */
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
  const theme = props.context.theme
  const [text, setText] = createSignal(`${props.initial.toString()}%`)
  const parsed = createMemo(() => {
    const value = parseSummaryPercent(text(), props.windowTokens)
    if (value === undefined || value < props.minPercent || value > props.maxPercent) return undefined
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
    <DialogFrame context={props.context} title={props.title} submit={props.copy.settings.submit}>
      <textarea
        height={1}
        wrapMode="none"
        initialValue={`${props.initial.toString()}%`}
        placeholder="10%"
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
        fallback={<text fg={theme.text.feedback.error.base}>{props.invalid}</text>}
      >
        {(value: () => number) => (
          <text fg={theme.text.muted}>
            {percentLabel(value(), props.windowTokens)}
          </text>
        )}
      </Show>
      <text fg={theme.text.muted}>
        {props.windowTokens === undefined
          ? props.copy.settings.windowUnknown
          : props.copy.settings.windowKnown(formatTokens(props.windowTokens))}
      </text>
      <text fg={theme.text.muted}>{props.hint}</text>
    </DialogFrame>
  )
}

/**
 * 输入：TUI 上下文 + 文案 + 初始值 + 确认回调。
 * 输出：压缩阈值的输入对话框。
 * 预期：只接受 60 ~ 95 的整数；解析失败回车不生效。
 */
export function ThresholdDialog(props: {
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
