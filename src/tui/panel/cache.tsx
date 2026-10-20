import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"

import type { Messages } from "../../i18n/index.ts"
import type { CacheSample } from "../../shared/cache.ts"
import { formatTokens } from "../../shared/format.ts"
import type { Settings } from "../../shared/settings.ts"
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  chartAxis,
  hitRateColor,
  renderBrailleChart,
  xAxisLabels,
  type ChartCell,
} from "../chart/cache-chart.ts"
import { themeHex } from "../chart/color.ts"
import type { UpdateSettings } from "../types.ts"

/** 输入：一行 chart cell；输出：可直接放进 `<text>` 的 span 序列。 */
function chartLine(row: readonly ChartCell[]) {
  return row.map((cell) =>
    cell.color === "" ? cell.char : <span style={{ fg: cell.color }}>{cell.char}</span>,
  )
}

/**
 * 输入：主题 + 文案 + 设置 + 写入函数 + 缓存样本。
 * 输出：可折叠的缓存记录区（Braille 折线 + 最近 10 次日志）。
 * 预期：样本由服务端持久化，这里只负责展示；0% 红 → 100% 绿。
 */
export function CacheSection(props: {
  readonly theme: Context["theme"]
  readonly copy: Messages
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
  readonly samples: readonly CacheSample[]
}) {
  const chartColors = createMemo(() => ({
    success: themeHex(props.theme.text.feedback.success.base, [34, 197, 94]),
    warning: themeHex(props.theme.text.feedback.warning.base, [234, 179, 8]),
    error: themeHex(props.theme.text.feedback.error.base, [239, 68, 68]),
  }))

  const latestHit = createMemo(() => props.samples.at(-1)?.hitRate)
  const axis = chartAxis(CHART_HEIGHT)
  const chartRows = createMemo(() => {
    if (props.samples.length === 0) return []
    return renderBrailleChart(
      props.samples.map((sample) => sample.hitRate),
      CHART_WIDTH,
      CHART_HEIGHT,
      (pct) => hitRateColor(pct, chartColors()),
      axis.gridRows,
      themeHex(props.theme.text.muted, [128, 128, 128]),
    )
  })

  /** 输入：折叠键；输出：无；预期：翻转后写回 TUI storage。 */
  const toggleFold = (
    key: "cacheExpanded" | "cacheChartExpanded" | "cacheLogExpanded",
  ): void => {
    void props.updateSettings((draft) => {
      draft[key] = !draft[key]
    })
  }

  return (
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
            <text fg={props.theme.text.base}>{props.settings.cacheExpanded ? "▼" : "▶"}</text>
            <text fg={props.theme.text.base}>
              <b>{props.copy.cacheTitle}</b>
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
                  <text fg={props.theme.text.base}>
                    {props.settings.cacheChartExpanded ? "▼" : "▶"}
                  </text>
                  <text fg={props.theme.text.base}>{props.copy.cacheChart}</text>
                </box>
                <Show when={props.settings.cacheChartExpanded}>
                  <Show
                    when={chartRows().length > 0}
                    fallback={<text fg={props.theme.text.muted}>{props.copy.noData}</text>}
                  >
                    <For each={chartRows()}>
                      {(row, index) => {
                        const label = axis.labels.find((item) => item.row === index())?.text ?? "    "
                        return (
                          <box flexDirection="row" height={1}>
                            <text fg={props.theme.text.muted}>{`${label} `}</text>
                            <text fg={props.theme.text.muted}>{"┤"}</text>
                            <text>{chartLine(row)}</text>
                          </box>
                        )
                      }}
                    </For>
                    <text fg={props.theme.text.muted}>{`  0% └${"─".repeat(CHART_WIDTH)}`}</text>
                    <text fg={props.theme.text.muted}>
                      {`${" ".repeat(6)}${xAxisLabels(props.samples.length, CHART_WIDTH)}`}
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
                  <text fg={props.theme.text.base}>
                    {props.settings.cacheLogExpanded ? "▼" : "▶"}
                  </text>
                  <text fg={props.theme.text.base}>{props.copy.cacheLog}</text>
                </box>
                <Show when={props.settings.cacheLogExpanded}>
                  <Show
                    when={props.samples.length > 0}
                    fallback={<text fg={props.theme.text.muted}>{props.copy.noData}</text>}
                  >
                    <box flexDirection="row" gap={1}>
                      <text width={5} textAlign="right" fg={props.theme.text.muted}>
                        {props.copy.cacheInput}
                      </text>
                      <text width={5} textAlign="right" fg={props.theme.text.muted}>
                        {props.copy.cacheOutput}
                      </text>
                      <text width={5} textAlign="right" fg={props.theme.text.muted}>
                        {props.copy.cacheCached}
                      </text>
                      <text width={5} textAlign="right" fg={props.theme.text.muted}>
                        {props.copy.cacheHit}
                      </text>
                    </box>
                    <For each={props.samples}>
                      {(sample) => (
                        <box flexDirection="row" gap={1}>
                          <text width={5} textAlign="right" fg={props.theme.text.muted}>
                            {formatTokens(sample.input)}
                          </text>
                          <text width={5} textAlign="right" fg={props.theme.text.muted}>
                            {formatTokens(sample.output)}
                          </text>
                          <text width={5} textAlign="right" fg={props.theme.text.muted}>
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
  )
}
