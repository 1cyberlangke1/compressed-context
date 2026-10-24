import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { modelTint, tintAt } from "../../shared/model-color.ts"
import { summarySegments, usedLayers, type Layer } from "../../shared/model-summary.ts"
import { localeArgument, resolveForModel, type Settings } from "../../shared/settings.ts"
import { toHex, toRgb } from "../chart/color.ts"
import type { UpdateSettings } from "../types.ts"

/**
 * 输入：TUI 上下文 + 设置。
 * 输出：侧栏「当前模型设置」分区——两行常驻，不折叠。
 * 预期：第一行是带品牌色的模型名 + 来源标签；第二行是完整字段名与折算后的数值。
 */
export function ModelPanel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const theme = props.context.theme
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))

  /** 当前提示词选中的模型；拿不到时给 undefined。 */
  const current = createMemo(() => props.context.ui.model.current())

  /** 该模型的条目（用于原生窗口）；模型列表还没同步时就是 undefined。 */
  const entry = createMemo(() => {
    const model = current()
    if (model === undefined) return undefined
    const list = props.context.data.location.model.list() ?? []
    return list.find((item) => item.providerID === model.providerID && item.modelID === model.modelID)
  })

  /** 合并后的设置：精确 > 同名 > 全局。 */
  const scoped = createMemo(() => {
    const model = current()
    return model === undefined
      ? props.settings
      : resolveForModel(props.settings, { providerID: model.providerID, id: model.modelID })
  })

  /** 来源标签，例如「全局 + 精确」。 */
  const sourceLabel = createMemo(() => {
    const model = current()
    const exact = model === undefined ? undefined : props.settings.models[`${model.providerID}/${model.modelID}`]
    const name = model === undefined ? undefined : props.settings.models[model.modelID]
    const names: Record<Layer, string> = {
      default: copy().modelPanel.sourceDefault,
      global: copy().modelPanel.sourceGlobal,
      name: copy().modelPanel.sourceName,
      exact: copy().modelPanel.sourceExact,
    }
    return usedLayers(props.settings, exact, name)
      .map((layer) => names[layer])
      .join(" + ")
  })

  /** 输入：无；输出：主题文字色的纯色序列。预期：主题色解析不出来时用近白。 */
  const themeSolid = (): readonly string[] => {
    const rgb = toRgb(theme.text.base)
    return [rgb === undefined ? "#e8e8e8" : toHex(rgb)]
  }

  /** 模型名；没有时用占位。 */
  const modelName = createMemo(() => {
    const model = current()
    return model === undefined ? copy().modelPanel.noModel : model.modelID
  })

  /** 模型名的颜色序列；未知模型退回主题文字色。 */
  const tint = createMemo(() => {
    const model = current()
    if (model === undefined) return themeSolid()
    return modelTint(model.modelID, model.providerID) ?? themeSolid()
  })

  const chars = createMemo(() => Array.from(modelName()))

  return (
    <box flexDirection="column">
      <text>
        <For each={chars()}>
          {(char, index) => (
            <span style={{ fg: tintAt(tint(), index(), chars().length) }}>{char}</span>
          )}
        </For>
        <span style={{ fg: theme.text.muted }}>{`  ${sourceLabel()}`}</span>
      </text>
      <box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <For each={summarySegments({ scoped: scoped(), native: entry()?.limit.context, copy: copy() })}>
          {(segment) => <text fg={theme.text.muted}>{segment}</text>}
        </For>
      </box>
    </box>
  )
}
