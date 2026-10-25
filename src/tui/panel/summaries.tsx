import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, SyntaxStyle } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import type { Messages } from "../../i18n/index.ts"
import type { SummaryBlock } from "../../shared/blocks.ts"
import { formatTimestamp, formatTokens } from "../../shared/format.ts"
import type { Settings } from "../../shared/settings.ts"
import type { UpdateSettings } from "../types.ts"

/** 最深色（0-1 归一化 RGB）：暗红，灰背景上仍清晰可辨。 */
const DEEP_TIER = { r: 0.47, g: 0.08, b: 0.08, a: 1 }

/**
 * 色相偏斜：>1 让浅层在青色上多停留一会儿，红只出现在深层。
 */
const DEPTH_GAMMA = 1.2

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 输入：0-1 RGB；输出：HSL（h 0-360，s/l 0-1）。预期：只用于深度渐变的色相插值。 */
function toHsl(color: Rgb): { readonly h: number; readonly s: number; readonly l: number } {
  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const delta = max - min
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  const h =
    max === color.r
      ? ((color.g - color.b) / delta + (color.g < color.b ? 6 : 0)) * 60
      : max === color.g
        ? ((color.b - color.r) / delta + 2) * 60
        : ((color.r - color.g) / delta + 4) * 60
  return { h, s, l }
}

/** 输入：HSL；输出：0-1 RGB。预期：与 toHsl 互逆，用于把色相渐变写回颜色。 */
function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) return { r: l, g: l, b: l }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  /** 输入：色相分量；输出：0-1 通道值。 */
  const channel = (value: number): number => {
    const t = ((value % 360) + 360) % 360
    if (t < 60) return p + ((q - p) * t) / 60
    if (t < 180) return q
    if (t < 240) return p + ((q - p) * (240 - t)) / 60
    return p
  }
  return { r: channel(h + 120), g: channel(h), b: channel(h - 120) }
}

/**
 * 输入：块树高 + 当前最大树高；输出：高度色。
 * 预期：高度 1 = info（青色），色相一路向红走（经过绿/黄），亮度同时压向暗红，
 *       所以是连续渐变——不会「两三级就整块变红」；同一高度的块颜色相同。
 */
export function heightColor(height: number, maxHeight: number, theme: Context["theme"]): RGBA {
  const info = theme.text.feedback.info.base
  const raw = maxHeight <= 1 ? 0 : Math.min(1, Math.max(0, (height - 1) / (maxHeight - 1)))
  if (raw === 0) return RGBA.fromValues(info.r, info.g, info.b, info.a)
  const t = Math.pow(raw, DEPTH_GAMMA)
  const start = toHsl(info)
  const end = toHsl(DEEP_TIER)
  // 色相只往「变暖」方向走：从起始色的色相一路降到 0（红），不绕远路。
  const hue = start.h * (1 - t)
  const rgb = fromHsl(hue, start.s + (end.s - start.s) * t, start.l + (end.l - start.l) * t)
  return RGBA.fromValues(rgb.r, rgb.g, rgb.b, info.a)
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
  const viewportHeight = createMemo(() => Math.max(8, Math.min(30, props.context.renderer.height - 8)))
  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={props.theme.text.base} wrapMode="word">
          <b>{`[T${props.block.tier.toString()}] {h${props.block.height.toString()}} ${props.block.id} : ${props.block.title}`}</b>
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
      <scrollbox height={viewportHeight()} scrollY={true} focused={true} width="100%">
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
  /** 当前链的最大折叠深度；用来把深度归一化到 0..1 的渐变。 */
  const maxHeight = createMemo(() => props.blocks.reduce((max, block) => Math.max(max, block.height), 1))

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
            <box flexDirection="column" width="100%">
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
                        <text width={2} fg={heightColor(block.height, maxHeight(), props.theme)}>
                          {hovered() === block.id ? (frame() === 0 ? "▸ " : " ▸") : "  "}
                        </text>
                        <text fg={props.theme.text.base} wrapMode="word" flexGrow={1}>
                          <span style={{ fg: heightColor(block.height, maxHeight(), props.theme) }}>
                            <b>{`[T${block.tier.toString()}] {h${block.height.toString()}}`}</b>
                          </span>
                          <span style={{ fg: props.theme.text.muted }}>
                            {` ${block.id} : `}
                          </span>
                          <span style={{ fg: props.theme.text.base }}>{block.title}</span>
                          <Show when={props.settings.showBlockTokens}>
                            <span style={{ fg: props.theme.text.muted }}>
                              {`  ≈${formatTokens(block.summaryTokens)}`}
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
