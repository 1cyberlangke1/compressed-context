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
  type ContextLimit,
  type LocaleSetting,
  type Settings,
  type SummaryFormat,
  type SummaryLanguage,
} from "../shared/settings.ts"
import { PercentDialog, ThresholdDialog, TokenDialog } from "./settings/dialogs.tsx"
import { buildSettingsOptions, type SettingsAction, type ToggleSetting } from "./settings/options.ts"
import type { UpdateSettings } from "./types.ts"

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
 * 输入：TUI 插件上下文 + 设置。
 * 输出：注册 /compressed-context 命令（斜杠 + 命令面板）。
 * 预期：打开设置菜单；所有文案来自语言文件，切换语言后命令会重新注册。
 */
export function SettingsCommand(props: {
  readonly context: Context
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}) {
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))
  const [resolvedWindow, setResolvedWindow] = createSignal<number | undefined>(undefined)

  /** 输入：无；输出：当前生效的窗口；预期：数字设置是上限，取 min(设置, 原生窗口)。 */
  const currentWindow = (): number | undefined => {
    const limit: unknown = props.settings.contextLimit
    const native = resolvedWindow()
    if (typeof limit === "number" && Number.isFinite(limit)) {
      return native === undefined ? limit : Math.min(limit, native)
    }
    return native
  }

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

  const openCustom = (): void => {
    openTokenField({
      title: copy().settings.limit,
      hint: copy().settings.limitHint,
      invalid: copy().settings.limitInvalid,
      placeholder: copy().settings.limitPlaceholder,
      initial: props.settings.contextLimit === "auto" ? "" : props.settings.contextLimit.toString(),
      min: MIN_CONTEXT_LIMIT,
      max: MAX_CONTEXT_LIMIT,
      apply: (draft, value) => {
        draft.contextLimit = value
      },
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
    void openSettings()
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

  const openLimit = async (): Promise<boolean> => {
    const picked = await props.context.ui.dialog.select<ContextLimit | "custom">({
      title: copy().settings.limit,
      current: props.settings.contextLimit,
      options: [
        { title: copy().settings.limitAuto, value: "auto" },
        ...PRESET_LIMITS.map((value) => ({ title: formatTokens(value), value })),
        { title: copy().settings.limitCustom, value: "custom" as const },
      ],
    })
    if (picked === undefined) return false
    if (picked === "custom") {
      openCustom()
      return true
    }
    await props.updateSettings((draft) => {
      draft.contextLimit = picked
    })
    return false
  }

  /**
   * 每个菜单项自己的处理，包含「谁重开主菜单」：
   * 选择型（语言/格式/总开关/上限）重开，弹窗型不重开，避免把对话框顶掉。
   */
  const handlers: Partial<Record<SettingsAction, () => void | Promise<void>>> = {
    show: async () => {
      await props.updateSettings((draft) => {
        draft.enabled = !draft.enabled
      })
      void openSettings()
    },
    limit: async () => {
      const custom = await openLimit()
      // 自定义对话框已经打开时不要再弹主菜单，否则会把它顶掉。
      if (!custom) void openSettings()
    },
    threshold: openThreshold,
    nudge: openNudge,
    blockPercent: openSummaryBlock,
    totalPercent: openSummaryTotal,
    summaryLanguage: async () => {
      await openSummaryLanguage()
      void openSettings()
    },
    summaryFormat: async () => {
      await openSummaryFormat()
      void openSettings()
    },
    autoCompress: () => toggleSetting("autoCompress"),
    enableCompressTool: () => toggleSetting("enableCompressTool"),
    enableDecompressTool: () => toggleSetting("enableDecompressTool"),
    showTimeline: () => toggleSetting("showTimeline"),
    showBlockTokens: () => toggleSetting("showBlockTokens"),
    showCacheChart: () => toggleSetting("showCacheChart"),
    showCacheLog: () => toggleSetting("showCacheLog"),
    showSummaries: () => toggleSetting("showSummaries"),
    decompressShowTokens: () => toggleSetting("decompressShowTokens"),
    decompressInlineMax: openDecompressInline,
    decompressTempCap: openDecompressCap,
    decompressTempMaxAgeHours: openDecompressMaxAge,
    language: async () => {
      await openLocale()
      void openSettings()
    },
  }

  async function openSettings(): Promise<void> {
    // 每次打开菜单都按当前会话模型刷新窗口，避免显示成别的模型。
    await fetchWindow(routeSessionID())
    const window = currentWindow()
    const picked = await props.context.ui.dialog.select<SettingsAction>({
      title: copy().settings.title,
      options: buildSettingsOptions({ settings: props.settings, copy: copy(), window }),
    })
    if (picked === undefined) return
    await handlers[picked]?.()
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
