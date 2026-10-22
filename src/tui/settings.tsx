import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"

import { formatTokens } from "../shared/format.ts"
import { resolveMessages } from "../i18n/index.ts"
import { contextRpc } from "../shared/rpc.ts"
import {
  localeArgument,
  MAX_CONTEXT_LIMIT,
  MAX_DECOMPRESS_INLINE_MAX,
  MAX_NUDGE_GROWTH_TOKENS,
  MAX_DECOMPRESS_TEMP_CAP,
  MIN_CONTEXT_LIMIT,
  MIN_DECOMPRESS_INLINE_MAX,
  MIN_DECOMPRESS_TEMP_CAP,
  effectiveDecompressInlineMax,
  effectiveDecompressTempCap,
  effectiveSummaryBlockPercent,
  effectiveSummaryLanguage,
  effectiveSummaryTotalPercent,
  maxSummaryPercent,
  serverSettingsPayload,
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

  // 设置变化时推给服务端；服务端插件未加载时静默忽略。
  createEffect(() => {
    try {
      void contextRpc(props.context.client)
        .settingsSet(serverSettingsPayload(props.settings))
        .catch(() => undefined)
    } catch {
      // server plugin not loaded
    }
  })

  const openNudge = (): void => {
    props.context.ui.dialog.show(() => (
      <TokenDialog
        context={props.context}
        copy={copy()}
        title={copy().settings.nudgeGrowth}
        hint={copy().settings.nudgeGrowthHint}
        invalid={copy().settings.nudgeGrowthInvalid}
        placeholder="50k"
        initial={props.settings.nudgeGrowthTokens === 0 ? "0" : formatTokens(props.settings.nudgeGrowthTokens)}
        min={0}
        max={MAX_NUDGE_GROWTH_TOKENS}
        allowZero
        onConfirm={(value) => {
          void props.updateSettings((draft) => {
            draft.nudgeGrowthTokens = value
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

  const openCustom = (): void => {
    props.context.ui.dialog.show(() => (
      <TokenDialog
        context={props.context}
        copy={copy()}
        title={copy().settings.limit}
        hint={copy().settings.limitHint}
        invalid={copy().settings.limitInvalid}
        placeholder={copy().settings.limitPlaceholder}
        initial={props.settings.contextLimit === "auto" ? "" : props.settings.contextLimit.toString()}
        min={MIN_CONTEXT_LIMIT}
        max={MAX_CONTEXT_LIMIT}
        onConfirm={(value) => {
          void props.updateSettings((draft) => {
            draft.contextLimit = value
          })
        }}
      />
    ))
  }

  const openSummaryBlock = (): void => {
    const window = currentWindow()
    props.context.ui.dialog.show(() => (
      <PercentDialog
        context={props.context}
        copy={copy()}
        title={copy().settings.summaryBlockPercent}
        hint={copy().settings.summaryBlockPercentHint}
        invalid={copy().settings.summaryPercentInvalid}
        initial={effectiveSummaryBlockPercent(props.settings)}
        windowTokens={window}
        minPercent={1}
        maxPercent={maxSummaryPercent(window)}
        onConfirm={(next) => {
          void props.updateSettings((draft) => {
            draft.summaryBlockPercent = next
          })
        }}
      />
    ))
  }

  const openSummaryTotal = (): void => {
    const window = currentWindow()
    props.context.ui.dialog.show(() => (
      <PercentDialog
        context={props.context}
        copy={copy()}
        title={copy().settings.summaryTotalPercent}
        hint={copy().settings.summaryTotalPercentHint}
        invalid={copy().settings.summaryPercentInvalid}
        initial={effectiveSummaryTotalPercent(props.settings)}
        windowTokens={window}
        minPercent={1}
        maxPercent={maxSummaryPercent(window)}
        onConfirm={(next) => {
          void props.updateSettings((draft) => {
            draft.summaryTotalPercent = next
          })
        }}
      />
    ))
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
    props.context.ui.dialog.show(() => (
      <TokenDialog
        context={props.context}
        copy={copy()}
        title={copy().settings.decompressInlineMax}
        hint={copy().settings.decompressInlineMaxHint}
        invalid={copy().settings.decompressInlineMaxInvalid}
        placeholder="10k"
        initial={formatTokens(effectiveDecompressInlineMax(props.settings))}
        min={MIN_DECOMPRESS_INLINE_MAX}
        max={MAX_DECOMPRESS_INLINE_MAX}
        onConfirm={(next) => {
          void props.updateSettings((draft) => {
            draft.decompressInlineMax = next
          })
        }}
      />
    ))
  }

  const openDecompressCap = (): void => {
    props.context.ui.dialog.show(() => (
      <TokenDialog
        context={props.context}
        copy={copy()}
        title={copy().settings.decompressTempCap}
        hint={copy().settings.decompressTempCapHint}
        invalid={copy().settings.decompressTempCapInvalid}
        placeholder="50"
        initial={effectiveDecompressTempCap(props.settings).toString()}
        min={MIN_DECOMPRESS_TEMP_CAP}
        max={MAX_DECOMPRESS_TEMP_CAP}
        onConfirm={(next) => {
          void props.updateSettings((draft) => {
            draft.decompressTempCap = next
          })
        }}
      />
    ))
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

  const openSettings = async (): Promise<void> => {
    // 每次打开菜单都按当前会话模型刷新窗口，避免显示成别的模型。
    await fetchWindow(routeSessionID())
    const window = currentWindow()
    const picked = await props.context.ui.dialog.select<SettingsAction>({
      title: copy().settings.title,
      options: buildSettingsOptions({ settings: props.settings, copy: copy(), window }),
    })
    if (picked === "show") {
      await props.updateSettings((draft) => {
        draft.enabled = !draft.enabled
      })
      void openSettings()
      return
    }
    if (picked === "limit") {
      const custom = await openLimit()
      // 自定义对话框已经打开时不要再弹主菜单，否则会把它顶掉。
      if (!custom) void openSettings()
      return
    }
    if (picked === "threshold") {
      openThreshold()
      return
    }
    if (picked === "nudge") {
      openNudge()
      return
    }
    if (picked === "blockPercent") {
      openSummaryBlock()
      return
    }
    if (picked === "totalPercent") {
      openSummaryTotal()
      return
    }
    if (picked === "summaryLanguage") {
      await openSummaryLanguage()
      void openSettings()
      return
    }
    if (picked === "summaryFormat") {
      await openSummaryFormat()
      void openSettings()
      return
    }
    if (
      picked === "autoCompress" ||
      picked === "enableCompressTool" ||
      picked === "enableDecompressTool" ||
      picked === "showTimeline" ||
      picked === "showBlockTokens" ||
      picked === "showCacheChart" ||
      picked === "showCacheLog" ||
      picked === "showSummaries" ||
      picked === "decompressShowTokens"
    ) {
      await toggleSetting(picked)
      return
    }
    if (picked === "decompressInlineMax") {
      openDecompressInline()
      return
    }
    if (picked === "decompressTempCap") {
      openDecompressCap()
      return
    }
    if (picked === "language") {
      await openLocale()
      void openSettings()
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
