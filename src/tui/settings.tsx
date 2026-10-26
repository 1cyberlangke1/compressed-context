import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, onMount } from "solid-js"

import { formatTokens } from "../shared/format.ts"
import { resolveMessages } from "../i18n/index.ts"
import { contextRpc, rpcLocation } from "../shared/rpc.ts"
import {
  localeArgument,
  MAX_CONTEXT_LIMIT,
  MAX_DECOMPRESS_INLINE_MAX,
  MAX_NUDGE_GROWTH_TOKENS,
  MAX_DECOMPRESS_TEMP_CAP,
  MAX_DECOMPRESS_TEMP_MAX_AGE_HOURS,
  MIN_CONTEXT_LIMIT,
  MIN_DECOMPRESS_INLINE_MAX,
  MIN_DECOMPRESS_TEMP_CAP,
  MIN_DECOMPRESS_TEMP_MAX_AGE_HOURS,
  effectiveDecompressInlineMax,
  effectiveDecompressTempCap,
  effectiveDecompressTempMaxAgeHours,
  effectiveSummaryBlockPercent,
  effectiveSummaryLanguage,
  effectiveSummaryTotalPercent,
  maxSummaryPercent,
  type LocaleSetting,
  type ModelIdentity,
  type ModelOverride,
  type ModelOverrideField,
  type Settings,
  type SummaryFormat,
  type SummaryLanguage,
} from "../shared/settings.ts"
import type { UpdateCheckResult } from "../shared/update.ts"
import { CountDialog, PercentDialog, ThresholdDialog, TokenDialog } from "./settings/dialogs.tsx"
import { effectiveWindow } from "../shared/model-summary.ts"
import {
  buildEditorOptions,
  buildFieldRows,
  buildPickerOptions,
  currentKeyOf,
  filterPicker,
  isExactKey,
  modelKey,
  providerCount,
  resolveScoped,
  toEntries,
  windowOf,
  type ModelEntry,
  type OverrideAction,
  type PickerValue,
} from "./settings/models.ts"
import {
  buildModelSectionOptions,
  buildSectionOptions,
  buildSettingsOptions,
  itemsOfGroup,
  type SettingsAction,
  type SettingsGroup,
  type SettingsSection,
  type ToggleSetting,
} from "./settings/options.ts"
import { createUpdateMenu, DEFAULT_UPDATE_DEPS, type UpdateDeps } from "./update-menu.tsx"
import { updateEntryState } from "./update-entry.ts"
import type { UpdateSettings } from "./types.ts"

/** 设置导航的返回结果：`back` 回上一层，`done` 结束（弹窗已经在屏幕上）。 */
type Flow = "back" | "done"

/** 可选上限预设；菜单里只出现合法值（最低 50k）。 */
const PRESET_LIMITS = [
  64_000,
  100_000,
  128_000,
  200_000,
  256_000,
  300_000,
  400_000,
  512_000,
  768_000,
  1_000_000,
] as const

/**
 * 输入：TUI 插件上下文 + 设置；`updateDeps` 仅供测试注入。
 * 输出：注册 /compressed-context 命令（斜杠 + 命令面板）。
 * 预期：打开设置菜单；所有文案来自语言文件，切换语言后命令会重新注册。
 */
export function SettingsCommand(props: {
  readonly context: Context
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
  readonly updateDeps?: UpdateDeps
}) {
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))
  const [resolvedWindow, setResolvedWindow] = createSignal<number | undefined>(undefined)
  const [updateResult, setUpdateResult] = createSignal<UpdateCheckResult | undefined>(undefined)
  /** 输入：无；输出：打开更新菜单的函数。预期：测试可注入假 registry 与假 spawn。 */
  const openUpdate = createUpdateMenu(props.context, copy, {
    deps: props.updateDeps ?? DEFAULT_UPDATE_DEPS,
    onResult: setUpdateResult,
  })

  /** 输入：无；输出：当前生效的窗口；预期：只剩模型原生窗口——全局不再有上限设置。 */
  const currentWindow = (): number | undefined => resolvedWindow()

  /** 输入：sessionID；输出：无；预期：按会话模型拉取原生窗口，失败保留旧值。 */
  const fetchWindow = async (sessionID: string | undefined): Promise<void> => {
    try {
      const got = await contextRpc(props.context.client).settingsGet(
        sessionID === undefined ? {} : { sessionID },
        rpcLocation(props.context),
      )
      if (typeof got.resolvedWindow === "number" && got.resolvedWindow > 0) setResolvedWindow(got.resolvedWindow)
    } catch {
      // server plugin not loaded
    }
  }

  /** 输入：无；输出：当前路由的 sessionID；预期：不在会话页时返回 undefined。 */
  const routeSessionID = (): string | undefined => {
    const route = props.context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  // 读取当前会话模型的原生窗口，auto 时也能把绝对值换算成百分比。
  onMount(() => {
    void fetchWindow(routeSessionID())
  })

  /**
   * 输入：TokenDialog 的差异字段 + 写回函数。
   * 输出：无。
   * 预期：统一弹窗与写回；allowZero 只在需要时传，避免把「允许 0」带给别的字段。
   */
  const openTokenField = (input: {
    readonly title: string
    readonly hint: string
    readonly invalid: string
    readonly placeholder: string
    readonly initial: string
    readonly min: number
    readonly max: number
    readonly allowZero?: boolean
    readonly apply: (draft: Settings, value: number) => void
  }): void => {
    props.context.ui.dialog.show(() => (
      <TokenDialog
        context={props.context}
        copy={copy()}
        title={input.title}
        hint={input.hint}
        invalid={input.invalid}
        placeholder={input.placeholder}
        initial={input.initial}
        min={input.min}
        max={input.max}
        {...(input.allowZero === true ? { allowZero: true } : {})}
        onConfirm={(value) => {
          void props.updateSettings((draft) => {
            input.apply(draft, value)
          })
        }}
      />
    ))
  }

  /**
   * 输入：PercentDialog 的差异字段 + 写回函数。
   * 输出：无。
   * 预期：共用当前窗口换算百分比上限与提示。
   */
  const openPercentField = (input: {
    readonly title: string
    readonly hint: string
    readonly initial: number
    readonly apply: (draft: Settings, value: number) => void
  }): void => {
    const window = currentWindow()
    props.context.ui.dialog.show(() => (
      <PercentDialog
        context={props.context}
        copy={copy()}
        title={input.title}
        hint={input.hint}
        invalid={copy().settings.summaryPercentInvalid}
        initial={input.initial}
        windowTokens={window}
        minPercent={1}
        maxPercent={maxSummaryPercent(window)}
        onConfirm={(next) => {
          void props.updateSettings((draft) => {
            input.apply(draft, next)
          })
        }}
      />
    ))
  }

  const openNudge = (): void => {
    openTokenField({
      title: copy().settings.nudgeGrowth,
      hint: copy().settings.nudgeGrowthHint,
      invalid: copy().settings.nudgeGrowthInvalid,
      placeholder: "50k",
      initial: props.settings.nudgeGrowthTokens === 0 ? "0" : formatTokens(props.settings.nudgeGrowthTokens),
      min: 0,
      max: MAX_NUDGE_GROWTH_TOKENS,
      allowZero: true,
      apply: (draft, value) => {
        draft.nudgeGrowthTokens = value
      },
    })
  }

  /** 输入：无；输出：无。预期：编辑全局默认的保留压缩块数，不设上下限，0 关闭保留区。 */
  const openRecentT1 = (): void => {
    props.context.ui.dialog.show(() => (
      <CountDialog
        context={props.context}
        copy={copy()}
        title={copy().settings.recentT1Blocks}
        hint={copy().settings.recentT1BlocksHint}
        invalid={copy().settings.recentT1BlocksInvalid}
        initial={props.settings.recentT1Blocks.toString()}
        onConfirm={(value) => {
          void props.updateSettings((draft) => {
            draft.recentT1Blocks = value
          })
        }}
      />
    ))
  }

  const openThreshold = (): void => {
    props.context.ui.dialog.show(() => (
      <ThresholdDialog
        context={props.context}
        copy={copy()}
        initial={props.settings.triggerPercent.toString()}
        onConfirm={(value) => {
          void props.updateSettings((draft) => {
            draft.triggerPercent = value
          })
        }}
      />
    ))
  }

  const openLocale = async (): Promise<void> => {
    const picked = await props.context.ui.dialog.select<LocaleSetting>({
      title: copy().settings.language,
      current: props.settings.locale,
      options: [
        { title: copy().settings.auto, value: "auto" },
        { title: copy().languages.zh, value: "zh" },
        { title: copy().languages.en, value: "en" },
      ],
    })
    if (picked === undefined) return
    await props.updateSettings((draft) => {
      draft.locale = picked
    })
  }

  const openSummaryBlock = (): void => {
    openPercentField({
      title: copy().settings.summaryBlockPercent,
      hint: copy().settings.summaryBlockPercentHint,
      initial: effectiveSummaryBlockPercent(props.settings),
      apply: (draft, value) => {
        draft.summaryBlockPercent = value
      },
    })
  }

  const openSummaryTotal = (): void => {
    openPercentField({
      title: copy().settings.summaryTotalPercent,
      hint: copy().settings.summaryTotalPercentHint,
      initial: effectiveSummaryTotalPercent(props.settings),
      apply: (draft, value) => {
        draft.summaryTotalPercent = value
      },
    })
  }

  const openSummaryLanguage = async (): Promise<void> => {
    const picked = await props.context.ui.dialog.select<SummaryLanguage>({
      title: copy().settings.summaryLanguage,
      current: effectiveSummaryLanguage(props.settings),
      options: [
        { title: copy().settings.auto, value: "auto" },
        { title: copy().languages.zh, value: "zh" },
        { title: copy().languages.en, value: "en" },
      ],
    })
    if (picked === undefined) return
    await props.updateSettings((draft) => {
      draft.summaryLanguage = picked
    })
  }

  const openSummaryFormat = async (): Promise<void> => {
    const picked = await props.context.ui.dialog.select<SummaryFormat>({
      title: copy().settings.summaryFormat,
      current: props.settings.summaryFormat,
      options: [
        { title: copy().settings.summaryFormatJson, value: "json" },
        { title: copy().settings.summaryFormatMarkdown, value: "markdown" },
        { title: copy().settings.summaryFormatBabel, value: "babel" },
      ],
    })
    if (picked === undefined) return
    await props.updateSettings((draft) => {
      draft.summaryFormat = picked
    })
  }

  /** 输入：布尔设置键；输出：无；预期：翻转后重开菜单。 */
  const toggleSetting = async (key: ToggleSetting): Promise<void> => {
    await props.updateSettings((draft) => {
      draft[key] = !draft[key]
    })
  }

  const openDecompressInline = (): void => {
    openTokenField({
      title: copy().settings.decompressInlineMax,
      hint: copy().settings.decompressInlineMaxHint,
      invalid: copy().settings.decompressInlineMaxInvalid,
      placeholder: "10k",
      initial: formatTokens(effectiveDecompressInlineMax(props.settings)),
      min: MIN_DECOMPRESS_INLINE_MAX,
      max: MAX_DECOMPRESS_INLINE_MAX,
      apply: (draft, value) => {
        draft.decompressInlineMax = value
      },
    })
  }

  const openDecompressCap = (): void => {
    openTokenField({
      title: copy().settings.decompressTempCap,
      hint: copy().settings.decompressTempCapHint,
      invalid: copy().settings.decompressTempCapInvalid,
      placeholder: "50",
      initial: effectiveDecompressTempCap(props.settings).toString(),
      min: MIN_DECOMPRESS_TEMP_CAP,
      max: MAX_DECOMPRESS_TEMP_CAP,
      apply: (draft, value) => {
        draft.decompressTempCap = value
      },
    })
  }

  const openDecompressMaxAge = (): void => {
    openTokenField({
      title: copy().settings.decompressTempMaxAgeHours,
      hint: copy().settings.decompressTempMaxAgeHoursHint,
      invalid: copy().settings.decompressTempMaxAgeHoursInvalid,
      placeholder: "24",
      initial: effectiveDecompressTempMaxAgeHours(props.settings).toString(),
      min: MIN_DECOMPRESS_TEMP_MAX_AGE_HOURS,
      max: MAX_DECOMPRESS_TEMP_MAX_AGE_HOURS,
      apply: (draft, value) => {
        draft.decompressTempMaxAgeHours = value
      },
    })
  }

  /** 输入：无；输出：当前 TUI 能看到的模型条目。预期：取不到数据时返回空数组，不抛错。 */
  const modelEntries = (): readonly ModelEntry[] => {
    try {
      const list = props.context.data.location.model.list() ?? []
      return toEntries(
        list.map((model) => ({
          providerID: model.providerID,
          id: model.modelID,
          name: model.name,
          limit: model.limit.context,
        })),
      )
    } catch {
      return []
    }
  }

  /** 输入：无；输出：提示词里当前选中的模型。 */
  const currentModel = (): ModelIdentity | undefined => {
    const picked = props.context.ui.model.current()
    return picked === undefined ? undefined : { providerID: picked.providerID, id: picked.modelID }
  }

  /** 输入：配置键；输出：展示名。预期：精确键显示成 [提供商]模型。 */
  const keyLabel = (key: string): string => {
    if (!isExactKey(key)) return key
    const slash = key.indexOf("/")
    return `[${key.slice(0, slash)}]${key.slice(slash + 1)}`
  }

  /** 输入：原覆盖 + 字段 + 值；输出：新覆盖。预期：只改一个字段，其余保留。 */
  const withField = (
    base: ModelOverride,
    field: ModelOverrideField,
    value: number | "auto",
  ): ModelOverride => {
    const next: ModelOverride = { ...base }
    if (field === "contextLimit") next.contextLimit = value
    else if (typeof value === "number") next[field] = value
    return next
  }

  /** 输入：键 + 字段 + 值；输出：无。预期：写回设置；服务端会裁掉等于继承的字段。 */
  const writeOverride = async (
    key: string,
    field: ModelOverrideField,
    value: number | "auto",
  ): Promise<void> => {
    await props.updateSettings((draft) => {
      draft.models[key] = withField(draft.models[key] ?? {}, field, value)
    })
  }

  /** 输入：键 + 字段；输出：无。预期：继承 / 预设 / 自定义三选一，写完回到编辑屏。 */
  /**
   * 输入：键 + 字段。
   * 输出：是否已打开输入弹窗。
   * 预期：继承与预设当场写回并返回 false（调用方重开编辑屏）；自定义返回 true，
   *       因为输入框已经在屏幕上，重开编辑屏会把它顶掉。
   */
  const openOverrideField = async (key: string, field: ModelOverrideField): Promise<boolean> => {
    const labels: Record<ModelOverrideField, string> = {
      contextLimit: copy().settings.limit,
      triggerPercent: copy().settings.threshold,
      nudgeGrowthTokens: copy().settings.nudgeGrowth,
      summaryBlockPercent: copy().settings.summaryBlockPercent,
      summaryTotalPercent: copy().settings.summaryTotalPercent,
      recentT1Blocks: copy().settings.recentT1Blocks,
    }
    const presets: readonly { readonly title: string; readonly value: number | "auto" }[] =
      field === "contextLimit"
        ? [
            { title: copy().settings.limitAuto, value: "auto" },
            ...PRESET_LIMITS.map((value) => ({ title: formatTokens(value), value })),
          ]
        : field === "triggerPercent"
          ? [60, 70, 75, 80, 85, 90, 95].map((value) => ({ title: `${value.toString()}%`, value }))
          : field === "nudgeGrowthTokens"
            ? [
                { title: copy().settings.off, value: 0 },
                ...[25_000, 50_000, 100_000].map((value) => ({ title: formatTokens(value), value })),
              ]
            : field === "recentT1Blocks"
              ? [0, 1, 2, 3, 4, 6, 8, 10].map((value) => ({
                  title: value.toString(),
                  value,
                }))
              : [5, 10, 15, 20, 25, 30, 40, 50].map((value) => ({ title: `${value.toString()}%`, value }))
    const picked = await props.context.ui.dialog.select<number | "auto" | "inherit" | "custom">({
      title: `${keyLabel(key)} · ${labels[field]}`,
      options: [
        { title: copy().settings.overrideInheritAction, value: "inherit" },
        ...presets.map((preset) => ({ title: preset.title, value: preset.value })),
        { title: copy().settings.overrideCustom, value: "custom" },
      ],
    })
    if (picked === undefined) return false
    if (picked === "inherit") {
      await props.updateSettings((draft) => {
        const bucket = { ...(draft.models[key] ?? {}) }
        Reflect.deleteProperty(bucket, field)
        if (Object.keys(bucket).length === 0) Reflect.deleteProperty(draft.models, key)
        else draft.models[key] = bucket
      })
      return false
    }
    if (picked === "custom") {
      openOverrideCustom(key, field)
      return true
    }
    await writeOverride(key, field, picked)
    return false
  }

  /** 输入：键 + 字段；输出：无。预期：弹输入框，确认后写回并回到编辑屏。 */
  const openOverrideCustom = (key: string, field: ModelOverrideField): void => {
    const scoped = resolveScoped(props.settings, key)
    const window = windowOf(modelEntries(), key)
    if (field === "triggerPercent") {
      props.context.ui.dialog.show(() => (
        <ThresholdDialog
          context={props.context}
          copy={copy()}
          initial={scoped.triggerPercent.toString()}
          onConfirm={(value) => {
            void writeOverride(key, field, value).then(() => openEditor(key))
          }}
        />
      ))
      return
    }
    if (field === "contextLimit") {
      props.context.ui.dialog.show(() => (
        <TokenDialog
          context={props.context}
          copy={copy()}
          title={copy().settings.limit}
          hint={copy().settings.limitHint}
          invalid={copy().settings.limitInvalid}
          placeholder={copy().settings.limitPlaceholder}
          initial={scoped.contextLimit === "auto" ? "" : scoped.contextLimit.toString()}
          min={MIN_CONTEXT_LIMIT}
          max={MAX_CONTEXT_LIMIT}
          onConfirm={(value) => {
            void writeOverride(key, field, value).then(() => openEditor(key))
          }}
        />
      ))
      return
    }
    if (field === "nudgeGrowthTokens") {
      props.context.ui.dialog.show(() => (
        <TokenDialog
          context={props.context}
          copy={copy()}
          title={copy().settings.nudgeGrowth}
          hint={copy().settings.nudgeGrowthHint}
          invalid={copy().settings.nudgeGrowthInvalid}
          placeholder="50k"
          initial={scoped.nudgeGrowthTokens === 0 ? "0" : formatTokens(scoped.nudgeGrowthTokens)}
          min={0}
          max={MAX_NUDGE_GROWTH_TOKENS}
          allowZero
          onConfirm={(value) => {
            void writeOverride(key, field, value).then(() => openEditor(key))
          }}
        />
      ))
      return
    }
    props.context.ui.dialog.show(() => (
      <PercentDialog
        context={props.context}
        copy={copy()}
        title={
          field === "summaryBlockPercent"
            ? copy().settings.summaryBlockPercent
            : copy().settings.summaryTotalPercent
        }
        hint={
          field === "summaryBlockPercent"
            ? copy().settings.summaryBlockPercentHint
            : copy().settings.summaryTotalPercentHint
        }
        invalid={copy().settings.summaryPercentInvalid}
        initial={field === "summaryBlockPercent" ? scoped.summaryBlockPercent : scoped.summaryTotalPercent}
        windowTokens={window}
        minPercent={1}
        maxPercent={maxSummaryPercent(window)}
        onConfirm={(value) => {
          void writeOverride(key, field, value).then(() => openEditor(key))
        }}
      />
    ))
  }

  /** 输入：配置键；输出：back 回上一屏，done 结束。预期：字段编辑屏；删除/重置后回覆盖列表。 */
  const openEditor = async (key: string): Promise<Flow> => {
    for (;;) {
      const native = windowOf(modelEntries(), key)
      // 标题写生效窗口（与侧栏一致），原生窗口留给上下文上限那一行解释。
      const window = effectiveWindow(resolveScoped(props.settings, key), native)
      const rows = buildFieldRows({ settings: props.settings, key, window: native, copy: copy() })
      const picked = await props.context.ui.dialog.select<OverrideAction>({
        title: window === undefined ? keyLabel(key) : `${keyLabel(key)} · ${formatTokens(window)}`,
        options: buildEditorOptions({ rows, copy: copy() }),
      })
      if (picked === undefined) return "back"
      if (picked.kind === "delete" || picked.kind === "resetAll") {
        await props.updateSettings((draft) => {
          Reflect.deleteProperty(draft.models, key)
        })
        return "back"
      }
      if (picked.kind === "back") return "back"
      // 自定义输入框已经在屏幕上，再重开编辑屏会把它顶掉。
      if (await openOverrideField(key, picked.field)) return "done"
    }
  }

  /** 输入：无；输出：back 回上一屏，done 结束。预期：已有覆盖列表 + 新增入口。 */
  const openOverrides = async (): Promise<Flow> => {
    for (;;) {
      const keys = Object.keys(props.settings.models)
      const picked = await props.context.ui.dialog.select<string>({
        title: copy().settings.modelOverrides,
        options: [
          ...keys.map((key) => ({
            title: keyLabel(key),
            value: key,
            footer: copy().settings.modelsConfigured(Object.keys(props.settings.models[key] ?? {}).length),
          })),
          { title: copy().settings.overrideAdd, value: "__add" },
        ],
      })
      if (picked === undefined) return "back"
      const result = picked === "__add" ? await openPicker() : await openEditor(picked)
      if (result === "done") return "done"
    }
  }

  /** 输入：无；输出：back 回上一屏，done 结束。预期：选模型（内置搜索），模型名级再问一次作用范围。 */
  const openPicker = async (): Promise<Flow> => {
    const entries = modelEntries()
    const currentKey = currentKeyOf(entries, currentModel())
    const picked = await props.context.ui.dialog.select<PickerValue>({
      title: copy().settings.modelPicker,
      placeholder: copy().settings.modelPickerHint,
      options: buildPickerOptions({ entries, overrides: props.settings.models, currentKey, copy: copy() }),
      search: (query, available) => filterPicker(query, available),
    })
    if (picked === undefined) return "back"
    if (isExactKey(picked.key) || providerCount(entries, picked.key) <= 1) {
      return openEditor(picked.key)
    }
    const scope = await props.context.ui.dialog.select<string>({
      title: copy().settings.modelScopeTitle,
      options: [
        { title: copy().settings.modelScopeAll(picked.key, providerCount(entries, picked.key)), value: "name" },
        ...entries
          .filter((entry) => entry.id === picked.key)
          .map((entry) => ({
            title: copy().settings.modelScopeExact(`[${entry.providerID}]${entry.id}`),
            value: modelKey(entry),
          })),
      ],
    })
    if (scope === undefined) return "back"
    return openEditor(scope === "name" ? picked.key : scope)
  }

  /** 输入：无；输出：back / done。预期：直接编辑当前模型；拿不到当前模型时退回选择器。 */
  const openCurrentModel = async (): Promise<Flow> => {
    const key = currentKeyOf(modelEntries(), currentModel())
    return key === undefined ? openPicker() : openEditor(key)
  }

  /**
   * 每个菜单项自己的处理。
   * 返回 true 表示已经在屏幕上打开了弹窗：调用方不要再重开列表，否则会把弹窗顶掉。
   */
  const handlers: Partial<Record<SettingsAction, () => boolean | Promise<boolean>>> = {
    show: async () => {
      await props.updateSettings((draft) => {
        draft.enabled = !draft.enabled
      })
      return false
    },
    threshold: () => {
      openThreshold()
      return true
    },
    nudge: () => {
      openNudge()
      return true
    },
    blockPercent: () => {
      openSummaryBlock()
      return true
    },
    totalPercent: () => {
      openSummaryTotal()
      return true
    },
    summaryLanguage: async () => {
      await openSummaryLanguage()
      return false
    },
    summaryFormat: async () => {
      await openSummaryFormat()
      return false
    },
    autoCompress: async () => {
      await toggleSetting("autoCompress")
      return false
    },
    enableCompressTool: async () => {
      await toggleSetting("enableCompressTool")
      return false
    },
    enableDecompressTool: async () => {
      await toggleSetting("enableDecompressTool")
      return false
    },
    enableCheckpointTreeTool: async () => {
      await toggleSetting("enableCheckpointTreeTool")
      return false
    },
    recentT1Blocks: () => {
      openRecentT1()
      return true
    },
    showTimeline: async () => {
      await toggleSetting("showTimeline")
      return false
    },
    showBlockTokens: async () => {
      await toggleSetting("showBlockTokens")
      return false
    },
    showCacheChart: async () => {
      await toggleSetting("showCacheChart")
      return false
    },
    showCacheLog: async () => {
      await toggleSetting("showCacheLog")
      return false
    },
    showSummaries: async () => {
      await toggleSetting("showSummaries")
      return false
    },
    decompressShowTokens: async () => {
      await toggleSetting("decompressShowTokens")
      return false
    },
    decompressInlineMax: () => {
      openDecompressInline()
      return true
    },
    decompressTempCap: () => {
      openDecompressCap()
      return true
    },
    decompressTempMaxAgeHours: () => {
      openDecompressMaxAge()
      return true
    },
    language: async () => {
      await openLocale()
      return false
    },
  }

  /** 输入：分组；输出：back 回上一层，done 结束（弹窗已在上面）。预期：Esc 逐层返回，动作完留在本组。 */
  async function openGroup(group: SettingsGroup): Promise<Flow> {
    for (;;) {
      const picked = await props.context.ui.dialog.select<SettingsAction>({
        title: copy().settings.categories[group],
        options: itemsOfGroup(
          buildSettingsOptions({ settings: props.settings, copy: copy(), window: currentWindow() }),
          group,
        ),
      })
      if (picked === undefined) return "back"
      if ((await handlers[picked]?.()) === true) return "done"
    }
  }

  /** 输入：无；输出：back 回第一层，done 结束。预期：按模型的两项循环。 */
  async function openModelSection(): Promise<Flow> {
    for (;;) {
      const currentKey = currentKeyOf(modelEntries(), currentModel())
      const picked = await props.context.ui.dialog.select<"current" | "overrides">({
        title: copy().settings.sectionModel,
        options: buildModelSectionOptions({
          settings: props.settings,
          copy: copy(),
          ...(currentKey === undefined ? {} : { currentModel: keyLabel(currentKey) }),
        }),
      })
      if (picked === undefined) return "back"
      const result = picked === "current" ? await openCurrentModel() : await openOverrides()
      if (result === "done") return "done"
    }
  }

  /**
   * 输入：无。
   * 输出：无。
   * 预期：第一层是 默认设置 / 按模型 / 摘要 / 开关 / 解压 / 界面 / 检查更新；
   *       esc 逐层返回，最外层才关闭；更新菜单关闭后回到第一层。
   */
  async function openSettings(): Promise<void> {
    for (;;) {
      // 每次打开菜单都按当前会话模型刷新窗口，避免显示成别的模型。
      await fetchWindow(routeSessionID())
      const currentKey = currentKeyOf(modelEntries(), currentModel())
      const section = await props.context.ui.dialog.select<SettingsSection>({
        title: copy().settings.title,
        options: buildSectionOptions({
          settings: props.settings,
          copy: copy(),
          updateEntry: updateEntryState(copy(), updateResult(), {
            warning: props.context.theme.text.feedback.warning.base,
            error: props.context.theme.text.feedback.error.base,
          }),
          ...(currentKey === undefined ? {} : { currentModel: keyLabel(currentKey) }),
        }),
      })
      if (section === undefined) return
      if (section === "update") {
        // 更新结束后退出设置，让结果 toast 显示在正常会话上。
        if (await openUpdate()) return
        continue
      }
      const result = section === "models" ? await openModelSection() : await openGroup(section)
      if (result === "done") return
    }
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "compressed-context.settings",
        title: copy().command.title,
        description: copy().command.description,
        group: copy().command.group,
        slash: { name: "compressed-context" },
        palette: true,
        run() {
          void openSettings()
        },
      },
    ],
  }))

  return null
}
