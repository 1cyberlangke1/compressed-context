import type { Context } from "@opencode/plugin/tui/context"
import { SyntaxStyle, type RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import type { Messages } from "../../i18n/index.ts"
import type { SummaryBlock } from "../../shared/blocks.ts"
import { formatTimestamp, formatTokens } from "../../shared/format.ts"
import type { Settings } from "../../shared/settings.ts"
import type { UpdateSettings } from "../types.ts"

/** 输入：摘要等级；输出：对应主题色；T1 蓝、T2 黄、T3 红。 */
function tierColor(tier: SummaryBlock["tier"], theme: Context["theme"]): RGBA {
  if (tier === 1) return theme.text.feedback.info.base
  if (tier === 2) return theme.text.feedback.warning.base
  return theme.text.feedback.error.base
}

/** 输入：TUI renderer；输出：共享的 SyntaxStyle，拿不到 resource owner 时返回 undefined。 */
let sharedSyntaxStyle: SyntaxStyle | undefined
function getSyntaxStyle(renderer: Context["renderer"]): SyntaxStyle | undefined {
  const owner = (renderer as { readonly nativeScene?: unknown }).nativeScene
  if (owner === undefined) return undefined
  sharedSyntaxStyle ??= SyntaxStyle.create(owner as Parameters<typeof SyntaxStyle.create>[0])
  return sharedSyntaxStyle
}

/**
 * 输入：TUI 上下文 + 主题 + 块。
 * 输出：占满可用高度的阅读弹窗。
 * 预期：标题保持 `[T1] b1 : title`；Babel 按纯文本显示，其余交给 markdown 渲染器，esc 关闭。
 */
export function SummaryDialog(props: {
  readonly context: Context
  readonly theme: Context["theme"]
  readonly block: SummaryBlock
}) {
  const height = createMemo(() => Math.max(8, Math.min(30, props.context.renderer.height - 8)))
  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={props.theme.text.base} wrapMode="word">
          <b>{`[T${props.block.tier.toString()}] ${props.block.id} : ${props.block.title}`}</b>
        </text>
        <text
          fg={props.theme.text.muted}
          onMouseUp={() => {
            props.context.ui.dialog.clear()
          }}
        >
          esc
        </text>
      </box>
      <scrollbox height={height()} scrollY={true} focused={true} width="100%">
        <Show when={props.block.format !== "babel"}>
          <Show
            when={getSyntaxStyle(props.context.renderer)}
            fallback={
              <text fg={props.theme.text.base} wrapMode="word">
                {props.block.body}
              </text>
            }
          >
            {(style) => (
              <markdown
                content={props.block.body}
                syntaxStyle={style()}
                fg={props.theme.text.base}
                conceal={true}
                tableOptions={{ widthMode: "full", style: "columns" }}
              />
            )}
          </Show>
        </Show>
        <Show when={props.block.format === "babel"}>
          <text fg={props.theme.text.base} wrapMode="word">
            {props.block.body}
          </text>
        </Show>
      </scrollbox>
    </box>
  )
}

/**
 * 输入：主题 + 文案 + 设置 + 写入函数 + 摘要块。
 * 输出：可折叠的摘要块列表；点击标题打开 markdown 阅读弹窗。
 * 预期：只展示服务端返回的 active 链；hover 只让箭头动，标题和背景保持稳定。
 */
export function SummarySection(props: {
  readonly context: Context
  readonly theme: Context["theme"]
  readonly copy: Messages
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
  readonly blocks: readonly SummaryBlock[]
}) {
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [frame, setFrame] = createSignal(0)

  // 只有 hover 时跑两帧；鼠标移出或销毁时清理，避免后台定时器。
  createEffect(() => {
    if (hovered() === undefined) {
      setFrame(0)
      return
    }
    const timer = setInterval(() => setFrame((value) => (value + 1) % 2), 180)
    onCleanup(() => {
      clearInterval(timer)
    })
  })

  /** 输入：无；输出：无；预期：翻转摘要区折叠状态。 */
  const toggleFold = (): void => {
    void props.updateSettings((draft) => {
      draft.summariesExpanded = !draft.summariesExpanded
    })
  }

  /** 输入：块；输出：无；预期：打开该块的 markdown 阅读弹窗。 */
  const openSummary = (block: SummaryBlock): void => {
    props.context.ui.dialog.show(() => (
      <SummaryDialog context={props.context} theme={props.theme} block={block} />
    ))
    props.context.ui.dialog.set({ size: "large", centered: true })
  }

  return (
    <Show when={props.settings.showSummaries}>
      <box width="100%" flexDirection="column">
        <box flexDirection="row" height={1} onMouseDown={toggleFold}>
          <box flexDirection="row" gap={1}>
            <text fg={props.theme.text.base}>{props.settings.summariesExpanded ? "▼" : "▶"}</text>
            <text fg={props.theme.text.base}>
              <b>{props.copy.summariesTitle}</b>
            </text>
            <text fg={props.theme.text.muted}>{`(${props.blocks.length.toString()})`}</text>
          </box>
        </box>
        <Show when={props.settings.summariesExpanded}>
          <Show
            when={props.blocks.length > 0}
            fallback={<text fg={props.theme.text.muted}>{props.copy.noData}</text>}
          >
            <box paddingLeft={2} flexDirection="column" width="100%">
              <For each={props.blocks}>
                {(block) => {
                  const meta = (): string => {
                    const parts: string[] = []
                    if (props.settings.showTimeline) parts.push(formatTimestamp(block.at))
                    if (block.sourceBlockIds !== undefined && block.sourceBlockIds.length > 0) {
                      parts.push(`merged ${block.sourceBlockIds.map((id) => `#${id}`).join(" + ")}`)
                    }
                    return parts.join("  ")
                  }
                  return (
                    <box flexDirection="column" width="100%">
                      <box
                        flexDirection="row"
                        gap={1}
                        onMouseOver={() => {
                          setHovered(block.id)
                        }}
                        onMouseOut={() => {
                          setHovered((current) => (current === block.id ? undefined : current))
                        }}
                        onMouseUp={() => {
                          openSummary(block)
                        }}
                      >
                        <text width={2} fg={tierColor(block.tier, props.theme)}>
                          {hovered() === block.id ? (frame() === 0 ? "▸ " : " ▸") : "  "}
                        </text>
                        <text fg={props.theme.text.base} wrapMode="word" flexGrow={1}>
                          <span style={{ fg: tierColor(block.tier, props.theme) }}>
                            <b>{`[T${block.tier.toString()}]`}</b>
                          </span>
                          <span style={{ fg: props.theme.text.muted }}>
                            {` ${block.id} : `}
                          </span>
                          <span style={{ fg: props.theme.text.base }}>{block.title}</span>
                          <Show when={props.settings.showBlockTokens}>
                            <span style={{ fg: props.theme.text.muted }}>
                              {`  ≈${formatTokens(block.tokensAfter)}`}
                            </span>
                          </Show>
                        </text>
                      </box>
                      <Show when={meta() !== ""}>
                        <text fg={props.theme.text.muted} wrapMode="word">
                          {`  ${meta()}`}
                        </text>
                      </Show>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}
