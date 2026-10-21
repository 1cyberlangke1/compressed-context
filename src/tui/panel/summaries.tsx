import type { Context } from "@opencode/plugin/tui/context"
import { SyntaxStyle, type RGBA } from "@opentui/core"
import { For, Show } from "solid-js"

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

/** 输入：无；输出：共享的 SyntaxStyle；预期：markdown 渲染器需要它，懒加载避免重复创建。 */
let sharedSyntaxStyle: SyntaxStyle | undefined
function getSyntaxStyle(): SyntaxStyle {
  sharedSyntaxStyle ??= SyntaxStyle.create()
  return sharedSyntaxStyle
}

/**
 * 输入：主题 + 文案 + 设置 + 写入函数 + 摘要块。
 * 输出：可折叠的摘要块列表；展开后固定 8 行 markdown 滚动区。
 * 预期：只展示服务端返回的 active 链；同时只展开一个块。
 */
export function SummarySection(props: {
  readonly theme: Context["theme"]
  readonly copy: Messages
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
  readonly blocks: readonly SummaryBlock[]
}) {
  /** 输入：无；输出：无；预期：翻转摘要区折叠状态。 */
  const toggleFold = (): void => {
    void props.updateSettings((draft) => {
      draft.summariesExpanded = !draft.summariesExpanded
    })
  }

  /** 输入：块 id；输出：无；预期：同时只展开一个块，再点一次收起。 */
  const toggleBlock = (id: string): void => {
    void props.updateSettings((draft) => {
      draft.expandedBlockId = draft.expandedBlockId === id ? "" : id
    })
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
                        onMouseDown={() => {
                          toggleBlock(block.id)
                        }}
                      >
                        <text wrapMode="word" flexGrow={1}>
                          <span style={{ fg: props.theme.text.base }}>
                            {props.settings.expandedBlockId === block.id ? "▼" : "▶"}
                          </span>
                          <span style={{ fg: tierColor(block.tier, props.theme) }}>
                            {` ${block.id}: ${block.title}`}
                          </span>
                          <span style={{ fg: props.theme.text.muted }}>
                            {`  [T${block.tier.toString()}]${
                              props.settings.showBlockTokens
                                ? `  ≈${formatTokens(block.tokensAfter)}`
                                : ""
                            }`}
                          </span>
                        </text>
                      </box>
                      <Show when={meta() !== ""}>
                        <text fg={props.theme.text.muted} wrapMode="word">
                          {`  ${meta()}`}
                        </text>
                      </Show>
                      <Show when={props.settings.expandedBlockId === block.id}>
                        <scrollbox height={8} scrollY={true} width="100%">
                          <markdown content={block.body} syntaxStyle={getSyntaxStyle()} />
                        </scrollbox>
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
