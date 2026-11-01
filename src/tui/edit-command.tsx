import type { Context } from "@opencode/plugin/tui/context"
import { createMemo } from "solid-js"

import { resolveMessages } from "../i18n/index.ts"
import { contextRpc, rpcLocation } from "../shared/rpc.ts"
import { localeArgument, type Settings } from "../shared/settings.ts"
import { BlockEditorDialog } from "./panel/block-editor.tsx"

/**
 * 输入：TUI 上下文 + 设置快照。
 * 输出：`/compressed-context-edit` 命令（无渲染内容）。
 * 预期：只在会话页生效；先选块，再打开预填原文的编辑器。
 *       这样不用鼠标也能改块（侧栏的 ✎ 只是同一入口的另一种点法）。
 */
export function EditCommand(props: { readonly context: Context; readonly settings: Settings }) {
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))

  /** 输入：无；输出：无。预期：取当前会话的 active 链并逐个选块编辑。 */
  const run = async (): Promise<void> => {
    const route = props.context.ui.router.current()
    if (route.type !== "session") {
      props.context.ui.toast.show({ message: copy().command.noSession, variant: "warning" })
      return
    }
    const sessionID = route.sessionID
    const rpc = contextRpc(props.context.client)
    const blocks = await rpc
      .blocksGet({ sessionID }, rpcLocation(props.context))
      .then((got) => got.blocks)
      .catch(() => undefined)
    if (blocks === undefined || blocks.length === 0) {
      props.context.ui.toast.show({ message: copy().command.noBlocks, variant: "warning" })
      return
    }
    const picked = await props.context.ui.dialog.select<string>({
      title: copy().command.editTitle,
      options: blocks.map((block) => ({
        title: `[T${block.tier.toString()}] {h${block.height.toString()}} ${block.id} : ${block.title}`,
        value: block.id,
      })),
    })
    if (picked === undefined) return
    const block = blocks.find((item) => item.id === picked)
    if (block === undefined) return
    props.context.ui.dialog.show(() => (
      <BlockEditorDialog
        context={props.context}
        copy={copy().blockEditor}
        sessionID={sessionID}
        block={block}
        onSaved={() => {
          // 面板由 session 事件驱动刷新；这里不用额外通知。
        }}
      />
    ))
    props.context.ui.dialog.set({ size: "large", centered: true })
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "compressed-context.edit",
        title: copy().command.editTitle,
        description: copy().command.editDescription,
        group: copy().command.group,
        slash: { name: "compressed-context-edit" },
        palette: true,
        run() {
          void run()
        },
      },
    ],
  }))

  return null
}

