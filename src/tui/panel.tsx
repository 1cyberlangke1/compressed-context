import type { Context } from "@opencode/plugin/tui/context"
import { SyntaxStyle, type RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import type { SummaryBlock } from "../blocks.ts"
import type { CacheSample } from "../cache.ts"
import { formatTimestamp, formatTokens } from "../format.ts"
import { resolveMessages } from "../i18n/index.ts"
import { ContextRpc } from "../rpc.ts"
import { effectiveLimit, localeArgument, type Settings } from "../settings.ts"
import { parseStats, scaleCategories, STATS_KEY, TERMINAL_KEY, type ContextStats } from "../stats.ts"
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  chartAxis,
  hitRateColor,
  renderBrailleChart,
  xAxisLabels,
  type ChartCell,
} from "./cache-chart.ts"
import { mix, toHex, toRgb, type Rgb } from "./color.ts"
import type { UpdateSettings } from "./types.ts"

/**
 * 输入：该分类占上下文总量的百分比 + 主题。
 * 输出：0%-50%-100% 依次绿-黄-红的连续插值。
 * 预期：每个百分比都有独立颜色；主题色不可解析时回退到内置色。
 */
function occupancyColor(pct: number, theme: Context["theme"]): string {
  const green = toRgb(theme.text.feedback.success.base) ?? ([34, 197, 94] as Rgb)
  const yellow = toRgb(theme.text.feedback.warning.base) ?? ([234, 179, 8] as Rgb)
  const red = toRgb(theme.text.feedback.error.base) ?? ([239, 68, 68] as Rgb)
  const ratio = Math.min(1, Math.max(0, pct / 100))
  if (ratio <= 0.5) return toHex(mix(green, yellow, ratio * 2))
  return toHex(mix(yellow, red, (ratio - 0.5) * 2))
}

/** 输入：摘要等级；输出：对应主题色；T1 蓝、T2 黄、T3 红。 */
function tierColor(tier: SummaryBlock["tier"], theme: Context["theme"]): RGBA {
  if (tier === 1) return theme.text.feedback.info.base
  if (tier === 2) return theme.text.feedback.warning.base
  return theme.text.feedback.error.base
}

/**
 * 输入：0-100 的百分比。
 * 输出：OpenTUI 的百分比宽度类型 `${number}%`。
 * 预期：先转字符串再断言——模板里直接插数字会被 lint 规则拦住，
 *       而 OpenTUI 只接受 `${number}%` 这种字面量类型。
 */
function percentWidth(value: number): `${number}%` {
  const clamped = Math.min(100, Math.max(0, value))
  return `${clamped.toString()}%` as `${number}%`
}

/** 输入：一行 chart cell；输出：可直接放进 `<text>` 的 span 序列。 */
function chartLine(row: readonly ChartCell[]) {
  return row.map((cell) =>
    cell.color === "" ? cell.char : <span style={{ fg: cell.color }}>{cell.char}</span>,
  )
}

/** 输入：无；输出：共享的 SyntaxStyle；预期：markdown 渲染器需要它，懒加载避免重复创建。 */
let sharedSyntaxStyle: SyntaxStyle | undefined
function getSyntaxStyle(): SyntaxStyle {
  sharedSyntaxStyle ??= SyntaxStyle.create()
  return sharedSyntaxStyle
}

/** 输入：主题色 + 回退 RGB；输出：hex 字符串。 */
function themeHex(value: unknown, fallback: Rgb): string {
  return toHex(toRgb(value) ?? fallback)
}

/**
 * 输入：TUI 上下文 + sessionID + 设置。
 * 输出：侧栏里的上下文分类面板（可折叠），外加缓存命中与摘要块。
 * 预期：分类条总量交给内置 Context 区块；缓存历史由服务端持久化，TUI 只读。
 */
export function Panel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const theme = props.context.theme
  const [stats, setStats] = createSignal<ContextStats>()
  const [terminal, setTerminal] = createSignal<string>()
  const [cache, setCache] = createSignal<readonly CacheSample[]>([])
  const [blocks, setBlocks] = createSignal<readonly SummaryBlock[]>([])
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

  const chartColors = createMemo(() => ({
    success: themeHex(theme.text.feedback.success.base, [34, 197, 94]),
    warning: themeHex(theme.text.feedback.warning.base, [234, 179, 8]),
    error: themeHex(theme.text.feedback.error.base, [239, 68, 68]),
  }))

  const latestHit = createMemo(() => cache().at(-1)?.hitRate)
  const axis = chartAxis(CHART_HEIGHT)
  const chartRows = createMemo(() => {
    const samples = cache()
    if (samples.length === 0) return []
    return renderBrailleChart(
      samples.map((sample) => sample.hitRate),
      CHART_WIDTH,
      CHART_HEIGHT,
      (pct) => hitRateColor(pct, chartColors()),
      axis.gridRows,
      themeHex(theme.text.muted, [128, 128, 128]),
    )
  })

  /** 输入：无；输出：RPC 客户端；预期：方法名在 PortableDefinition 上退化成索引签名，这里补回形状。 */
  const rpc = () =>
    props.context.client.rpc(ContextRpc) as unknown as {
      cacheHistoryGet(input: { sessionID: string }): Promise<{ samples: readonly CacheSample[] }>
      blocksGet(input: { sessionID: string }): Promise<{ blocks: readonly SummaryBlock[] }>
    }

  /** 输入：无；输出：无；预期：从服务端拉取该会话持久化的缓存历史。 */
  const refreshCache = async (): Promise<void> => {
    try {
      const got = await rpc().cacheHistoryGet({ sessionID: props.sessionID })
      setCache(got.samples)
    } catch {
      // server plugin not loaded；保留上一次数据
    }
  }

  /** 输入：无；输出：无；预期：从服务端拉取 active 摘要链。 */
  const refreshBlocks = async (): Promise<void> => {
    if (!props.settings.showSummaries) return
    try {
      const got = await rpc().blocksGet({ sessionID: props.sessionID })
      setBlocks(got.blocks)
    } catch {
      // server plugin not loaded；保留上一次数据
    }
  }

  /** 输入：无；输出：无；预期：从服务端重新拉取 session metadata 里的统计。 */
  const refresh = async (): Promise<void> => {
    try {
      const info = await props.context.client.session.get({ sessionID: props.sessionID })
      setStats(parseStats(info.metadata?.[STATS_KEY]))
      const rawTerminal = info.metadata?.[TERMINAL_KEY]
      setTerminal(typeof rawTerminal === "string" ? rawTerminal : undefined)
    } catch {
      // 统计缺失不影响主界面，保持上一次的值
    }
  }

  // 显示开关变化时重新拉取；首次挂载也会跑一次。
  createEffect(() => {
    if (props.settings.showCacheChart || props.settings.showCacheLog) void refreshCache()
  })
  createEffect(() => {
    if (props.settings.showSummaries) void refreshBlocks()
  })

  createEffect(() => {
    void refresh()
  })

  onCleanup(
    props.context.data.on("session.usage.updated", (event) => {
      if (event.data.sessionID !== props.sessionID) return
      void refresh()
      // 缓存历史由服务端在 usage.updated 时补写；这里同步刷新面板。
      if (props.settings.showCacheChart || props.settings.showCacheLog) void refreshCache()
    }),
  )
  onCleanup(
    props.context.data.on("session.compaction.ended", (event) => {
      if (event.data.sessionID !== props.sessionID) return
      void refresh()
      void refreshCache()
      void refreshBlocks()
    }),
  )
  onCleanup(
    props.context.data.on("session.idle", (event) => {
      if (event.data.sessionID !== props.sessionID) return
      void refresh()
      void refreshCache()
      void refreshBlocks()
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

  /** 输入：折叠键；输出：无；预期：翻转后写回 TUI storage。 */
  const toggleFold = (
    key: "cacheExpanded" | "cacheChartExpanded" | "cacheLogExpanded" | "summariesExpanded",
  ): void => {
    void props.updateSettings((draft) => {
      draft[key] = !draft[key]
    })
  }

  /** 输入：块 id；输出：无；预期：同时只展开一个块，再点一次收起。 */
  const toggleBlock = (id: string): void => {
    void props.updateSettings((draft) => {
      draft.expandedBlockId = draft.expandedBlockId === id ? "" : id
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
        <Show when={terminal()}>
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            {`⚠ ${copy().terminal}`}
          </text>
        </Show>
        <Show when={props.settings.expanded}>
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row" height={1} gap={1}>
                <text fg={theme.text.muted} width={10} flexShrink={0}>
                  {copy().labels[row.key]}
                </text>
                <box flexGrow={1} height={1} backgroundColor={theme.background.raised.high}>
                  <box height={1} width={percentWidth(row.pct)} backgroundColor={occupancyColor(row.pct, theme)} />
                </box>
                <text fg={theme.text.muted} width={4} flexShrink={0} textAlign="right">
                  {`${row.pct.toString()}%`}
                </text>
                <text fg={theme.text.muted} width={7} flexShrink={0} textAlign="right">
                  {`${copy().approximate}${formatTokens(row.value)}`}
                </text>
              </box>
            )}
          </For>

          <Show when={props.settings.showCacheChart || props.settings.showCacheLog}>
            <box width="100%" flexDirection="column">
              <box
                flexDirection="row"
                height={1}
                justifyContent="space-between"
                onMouseDown={() => {
                  toggleFold("cacheExpanded")
                }}
              >
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text.base}>{props.settings.cacheExpanded ? "▼" : "▶"}</text>
                  <text fg={theme.text.base}>
                    <b>{copy().cacheTitle}</b>
                  </text>
                </box>
                <Show when={latestHit() !== undefined}>
                  <text fg={hitRateColor(latestHit() ?? 0, chartColors())}>
                    {`${(latestHit() ?? 0).toString()}%`}
                  </text>
                </Show>
              </box>
              <Show when={props.settings.cacheExpanded}>
                <box paddingLeft={2} flexDirection="column" width="100%">
                  <Show when={props.settings.showCacheChart}>
                    <box flexDirection="column" width="100%">
                      <box
                        flexDirection="row"
                        height={1}
                        gap={1}
                        onMouseDown={() => {
                          toggleFold("cacheChartExpanded")
                        }}
                      >
                        <text fg={theme.text.base}>
                          {props.settings.cacheChartExpanded ? "▼" : "▶"}
                        </text>
                        <text fg={theme.text.base}>{copy().cacheChart}</text>
                      </box>
                      <Show when={props.settings.cacheChartExpanded}>
                        <Show
                          when={chartRows().length > 0}
                          fallback={<text fg={theme.text.muted}>{copy().noData}</text>}
                        >
                          <For each={chartRows()}>
                            {(row, index) => {
                              const label =
                                axis.labels.find((item) => item.row === index())?.text ?? "    "
                              return (
                                <box flexDirection="row" height={1}>
                                  <text fg={theme.text.muted}>{`${label} `}</text>
                                  <text fg={theme.text.muted}>{"┤"}</text>
                                  <text>{chartLine(row)}</text>
                                </box>
                              )
                            }}
                          </For>
                          <text fg={theme.text.muted}>
                            {`  0% └${"─".repeat(CHART_WIDTH)}`}
                          </text>
                          <text fg={theme.text.muted}>
                            {`${" ".repeat(6)}${xAxisLabels(cache().length, CHART_WIDTH)}`}
                          </text>
                        </Show>
                      </Show>
                    </box>
                  </Show>

                  <Show when={props.settings.showCacheLog}>
                    <box flexDirection="column" width="100%">
                      <box
                        flexDirection="row"
                        height={1}
                        gap={1}
                        onMouseDown={() => {
                          toggleFold("cacheLogExpanded")
                        }}
                      >
                        <text fg={theme.text.base}>
                          {props.settings.cacheLogExpanded ? "▼" : "▶"}
                        </text>
                        <text fg={theme.text.base}>{copy().cacheLog}</text>
                      </box>
                      <Show when={props.settings.cacheLogExpanded}>
                        <Show
                          when={cache().length > 0}
                          fallback={<text fg={theme.text.muted}>{copy().noData}</text>}
                        >
                          <box flexDirection="row" gap={1}>
                            <text width={5} textAlign="right" fg={theme.text.muted}>
                              {copy().cacheInput}
                            </text>
                            <text width={5} textAlign="right" fg={theme.text.muted}>
                              {copy().cacheOutput}
                            </text>
                            <text width={5} textAlign="right" fg={theme.text.muted}>
                              {copy().cacheCached}
                            </text>
                            <text width={5} textAlign="right" fg={theme.text.muted}>
                              {copy().cacheHit}
                            </text>
                          </box>
                          <For each={cache()}>
                            {(sample) => (
                              <box flexDirection="row" gap={1}>
                                <text width={5} textAlign="right" fg={theme.text.muted}>
                                  {formatTokens(sample.input)}
                                </text>
                                <text width={5} textAlign="right" fg={theme.text.muted}>
                                  {formatTokens(sample.output)}
                                </text>
                                <text width={5} textAlign="right" fg={theme.text.muted}>
                                  {formatTokens(sample.cached)}
                                </text>
                                <text
                                  width={5}
                                  textAlign="right"
                                  fg={hitRateColor(sample.hitRate, chartColors())}
                                >
                                  {`${sample.hitRate.toString()}%`}
                                </text>
                              </box>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </Show>

          <Show when={props.settings.showSummaries}>
            <box width="100%" flexDirection="column">
              <box
                flexDirection="row"
                height={1}
                justifyContent="space-between"
                onMouseDown={() => {
                  toggleFold("summariesExpanded")
                }}
              >
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text.base}>{props.settings.summariesExpanded ? "▼" : "▶"}</text>
                  <text fg={theme.text.base}>
                    <b>{copy().summariesTitle}</b>
                  </text>
                </box>
                <text fg={theme.text.muted}>{blocks().length.toString()}</text>
              </box>
              <Show when={props.settings.summariesExpanded}>
                <Show
                  when={blocks().length > 0}
                  fallback={<text fg={theme.text.muted}>{copy().noData}</text>}
                >
                  <box paddingLeft={2} flexDirection="column" width="100%">
                    <For each={blocks()}>
                      {(block) => {
                        const meta = (): string => {
                          const parts: string[] = []
                          if (props.settings.showTimeline) parts.push(formatTimestamp(block.at))
                          if (block.sourceBlockIds !== undefined && block.sourceBlockIds.length > 0) {
                            parts.push(
                              `merged ${block.sourceBlockIds.map((id) => `#${id}`).join(" + ")}`,
                            )
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
                                <span style={{ fg: theme.text.base }}>
                                  {props.settings.expandedBlockId === block.id ? "▼" : "▶"}
                                </span>
                                <span style={{ fg: tierColor(block.tier, theme) }}>
                                  {` ${block.id}: ${block.title}`}
                                </span>
                                <span style={{ fg: theme.text.muted }}>
                                  {`  [T${block.tier.toString()}]${
                                    props.settings.showBlockTokens
                                      ? `  ≈${formatTokens(block.tokensAfter)}`
                                      : ""
                                  }`}
                                </span>
                              </text>
                            </box>
                            <Show when={meta() !== ""}>
                              <text fg={theme.text.muted} wrapMode="word">
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
        </Show>
      </box>
    </Show>
  )
}
