import type { Context } from "@opencode/plugin/tui/context"
import type { TextareaRenderable } from "@opentui/core"
import { createSignal, Show } from "solid-js"

import type { Messages } from "../../i18n/types.ts"
import type { SummaryBlock } from "../../shared/blocks.ts"
import { contextRpc, rpcLocation, type BlockUpdateResult } from "../../shared/rpc.ts"

/** 输入：服务端回执；输出：当前语言下的错误文案。预期：未知码也给出兜底文案而不是空白。 */
function errorText(copy: Messages["blockEditor"], result: BlockUpdateResult): string {
  const a = result.a ?? "?"
  const b = result.b ?? "?"
  switch (result.code) {
    case "compacting":
      return copy.errors.compacting
    case "nul":
      return copy.errors.nul
    case "notFound":
      return copy.errors.notFound
    case "merged":
      return copy.errors.merged
    case "stale":
      return copy.errors.stale
    case "legacyJson":
      return copy.errors.legacyJson
    case "badHeader":
      return copy.errors.badHeader
    case "noSession":
      return copy.errors.noSession
    case "foreignSession":
      return copy.errors.foreignSession
    case "tooLong":
      return copy.errors.tooLong(a, b)
    case "notSmaller":
      return copy.errors.notSmaller(a, b)
    case "chainBudget":
      return copy.errors.chainBudget(a, b)
    default:
      return copy.errors.unknown
  }
}

/**
 * 输入：TUI 上下文 + 文案 + 会话 + 块 + 保存成功回调。
 * 输出：带原文预填的多行编辑弹窗。
 * 预期：打开就是这块现在的正文，用户在上面直接改；
 *       ctrl+s 才写盘，esc 一律取消；失败留在弹窗里显示原因，成功才关闭并刷新面板。
 */
export function BlockEditorDialog(props: {
  readonly context: Context
  readonly copy: Messages["blockEditor"]
  readonly sessionID: string
  readonly block: SummaryBlock
  readonly onSaved: () => void
}) {
  const theme = props.context.theme
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [hovered, setHovered] = createSignal<"cancel" | "save" | undefined>(undefined)
  const cancelColor = () =>
    hovered() === "cancel" ? theme.text.feedback.error.base : theme.text.muted
  const saveColor = () =>
    hovered() === "save" ? theme.text.feedback.success.base : theme.text.muted
  let textarea: TextareaRenderable | undefined
  const height = Math.max(10, Math.min(28, props.context.renderer.height - 8))

  /** 输入：无；输出：无。预期：只有用户明确触发才写盘；文本没变就直接关掉，不碰状态。 */
  const save = async (): Promise<void> => {
    if (busy()) return
    const text = textarea?.plainText ?? props.block.body
    if (text === props.block.body) {
      props.context.ui.dialog.clear()
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await contextRpc(props.context.client).blockUpdate(
        {
          sessionID: props.sessionID,
          blockID: props.block.id,
          expectedAt: props.block.at,
          text,
        },
        rpcLocation(props.context),
      )
      if (!result.ok) {
        setError(errorText(props.copy, result))
        setBusy(false)
        return
      }
      props.context.ui.dialog.clear()
      props.context.ui.toast.show({
        title: props.copy.saved,
        message: props.block.id,
        variant: "success",
      })
      props.onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  // 宿主对话框会先截走带修饰键的组合；这里挂 keymap 命令，让 ctrl+s / alt+s 真正能保存。
  props.context.keymap.layer(() => ({
    mode: "global",
    target: () => textarea ?? null,
    commands: [
      {
        id: "compressed-context.block.save",
        bind: "ctrl+s",
        run() {
          void save()
        },
      },
      {
        id: "compressed-context.block.save-alt",
        bind: "alt+s",
        run() {
          void save()
        },
      },
    ],
  }))

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme.text.base}>
          <b>{`${props.copy.title}  ${props.block.id}`}</b>
        </text>
        <box flexDirection="row" gap={2}>
          <text
            fg={cancelColor()}
            onMouseOver={() => {
              setHovered("cancel")
            }}
            onMouseOut={() => {
              setHovered((current) => (current === "cancel" ? undefined : current))
            }}
            onMouseUp={() => {
              props.context.ui.dialog.clear()
            }}
          >
            {props.copy.cancel}
          </text>
          <text
            fg={saveColor()}
            onMouseOver={() => {
              setHovered("save")
            }}
            onMouseOut={() => {
              setHovered((current) => (current === "save" ? undefined : current))
            }}
            onMouseUp={() => {
              void save()
            }}
          >
            {props.copy.save}
          </text>
        </box>
      </box>
      <textarea
        ref={(value: TextareaRenderable) => {
          textarea = value
        }}
        height={height}
        width="100%"
        wrapMode="word"
        initialValue={props.block.body}
        focused={true}
        textColor={theme.text.base}
        focusedTextColor={theme.text.base}
        onKeyDown={(event) => {
          // esc 只取消，绝不保存。
          if (event.name === "escape") props.context.ui.dialog.clear()
        }}
        keyBindings={[
          { name: "s", ctrl: true, action: "submit" },
          // 有些终端把 ctrl+s 当成流控吞掉；alt+s / F2 是同一动作的备用键。
          { name: "s", meta: true, action: "submit" },
          { name: "f2", action: "submit" },
        ]}
        onSubmit={() => {
          void save()
        }}
      />
      <Show
        when={error() !== undefined}
        fallback={<text fg={theme.text.muted}>{busy() ? "…" : props.copy.hint}</text>}
      >
        <text fg={theme.text.feedback.error.base} wrapMode="word">
          {error() ?? ""}
        </text>
      </Show>
    </box>
  )
}

