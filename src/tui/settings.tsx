import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onMount, Show, type ParentProps } from "solid-js"

import { formatTokens } from "../format.ts"
import { resolveMessages, type Messages } from "../i18n/index.ts"
import { ContextRpc } from "../rpc.ts"
import {
  isContextLimit,
  localeArgument,
  MAX_CONTEXT_LIMIT,
  MAX_DECOMPRESS_INLINE_MAX,
  MAX_DECOMPRESS_TEMP_CAP,
  MAX_TRIGGER_PERCENT,
  MIN_CONTEXT_LIMIT,
  MIN_DECOMPRESS_INLINE_MAX,
  MIN_DECOMPRESS_TEMP_CAP,
  MIN_TRIGGER_PERCENT,
  effectiveDecompressInlineMax,
  effectiveDecompressTempCap,
  effectiveSummaryBlockPercent,
  effectiveSummaryLanguage,
  effectiveSummaryTotalPercent,
  maxSummaryPercent,
  parseSummaryPercent,
  parseTokenCount,
  percentToChars,
  type ContextLimit,
  type LocaleSetting,
  type Settings,
  type SummaryLanguage,
} from "../settings.ts"
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

/** 输入：设置；输出：当前语言标签；预期：用于设置菜单右侧的当前值。 */
function localeLabel(settings: Settings, copy: Messages): string {
  if (settings.locale === "auto") return copy.settings.auto
  if (settings.locale === "zh") return copy.languages.zh
  return copy.languages.en
}

/** 输入：设置；输出：当前摘要语言标签。 */
function summaryLanguageLabel(settings: Settings, copy: Messages): string {
  const language = effectiveSummaryLanguage(settings)
  if (language === "zh") return copy.languages.zh
  if (language === "en") return copy.languages.en
  return copy.settings.auto
}

/** 输入：设置 + 已知窗口；输出：上下文上限标签；数字设置是上限，被模型原生窗口压低时显示箭头。 */
function limitLabel(settings: Settings, copy: Messages, window: number | undefined): string {
  const value: unknown = settings.contextLimit
  if (!isContextLimit(value) || value === "auto") {
    return window === undefined ? copy.settings.limitAuto : `${copy.settings.limitAuto} (${formatTokens(window)})`
  }
  if (window !== undefined && window < value) {
    return `${formatTokens(value)} → ${formatTokens(window)}`
  }
  return formatTokens(value)
}

/** 输入：百分比 + 窗口；输出：`10% ≈ 20k` 这样的标签。 */
function percentLabel(percent: number, window: number | undefined): string {
  const chars = percentToChars(percent, window)
  return chars === undefined
    ? `${percent.toString()}%`
    : `${percent.toString()}% ≈ ${formatTokens(chars)}`
}

/**
 * 输入：TUI 上下文 + 标题 + 内容。
 * 输出：与原生对话框一致的外框（左右 3 格内边距、标题栏、底部操作行）。
 * 预期：标题在左、esc 在右；内容区与底部操作行各留一空行。
 */
function DialogFrame(
  props: ParentProps<{ readonly context: Context; readonly title: string; readonly submit: string }>,
) {
  const theme = props.context.theme
  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme.text.base}>
          <b>{props.title}</b>
        </text>
        <text
          fg={theme.text.muted}
          onMouseUp={() => {
            props.context.ui.dialog.clear()
          }}
        >
          esc
        </text>
      </box>
      <box gap={1}>{props.children}</box>
      <text fg={theme.text.muted}>{props.submit} enter</text>
    </box>
  )
}

/**
 * 输入：TUI 上下文 + 文案 + 标题/提示 + 初始值 + 合法范围 + 确认回调。
 * 输出：通用 token 输入对话框；上下文上限共用。
 * 预期：只接受数字 + 结尾 k/m；解析成功才允许回车提交，非法时只提示不写入。
 */
function TokenDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly title: string
  readonly hint: string
  readonly invalid: string
  readonly placeholder: string
  readonly initial: string
  readonly min: number
  readonly max: number
  readonly onConfirm: (value: number) => void
}) {
  const theme = props.context.theme
  const [text, setText] = createSignal(props.initial)
  const parsed = createMemo(() => parseTokenCount(text(), props.min, props.max))
  let area: { plainText: string } | undefined

  const confirm = (): void => {
    const value = parsed()
    if (value === undefined) return
    props.onConfirm(value)
    props.context.ui.dialog.clear()
  }

  // 原生 DialogPrompt 用模态层接管回车；这里同样注册，避免 textarea 插入换行。
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [{ bind: "enter", title: "Submit", group: "Dialog", run: confirm }],
  }))

  return (
    <DialogFrame context={props.context} title={props.title} submit={props.copy.settings.submit}>
      <textarea
        height={1}
        wrapMode="none"
        initialValue={props.initial}
        placeholder={props.placeholder}
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.base}
        onContentChange={() => setText(area?.plainText ?? "")}
        ref={(input) => {
          area = input
          setTimeout(() => {
            if (!input.isDestroyed) input.focus()
          }, 1)
        }}
      />
      <Show
        when={parsed()}
        fallback={<text fg={theme.text.feedback.error.base}>{props.invalid}</text>}
      >
        {(value: () => number) => (
          <text fg={theme.text.muted}>{props.copy.settings.limitPreview(formatTokens(value()))}</text>
        )}
      </Show>
      <text fg={theme.text.muted}>{props.hint}</text>
    </DialogFrame>
  )
}

/**
 * 输入：TUI 上下文 + 文案 + 初始百分比 + 窗口 + 允许范围 + 确认回调。
 * 输出：摘要上限对话框。
 * 预期：接受 `10%` 或 `20k`/`20000`；绝对值按窗口换算；超出范围不提交。
 */
function PercentDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly title: string
  readonly hint: string
  readonly invalid: string
  readonly initial: number
  readonly windowTokens: number | undefined
  readonly minPercent: number
  readonly maxPercent: number
  readonly onConfirm: (value: number) => void
}) {
  const theme = props.context.theme
  const [text, setText] = createSignal(`${props.initial.toString()}%`)
  const parsed = createMemo(() => {
    const value = parseSummaryPercent(text(), props.windowTokens)
    if (value === undefined || value < props.minPercent || value > props.maxPercent) return undefined
    return value
  })
  let area: { plainText: string } | undefined

  const confirm = (): void => {
    const value = parsed()
    if (value === undefined) return
    props.onConfirm(value)
    props.context.ui.dialog.clear()
  }

  // 原生 DialogPrompt 用模态层接管回车；这里同样注册，避免 textarea 插入换行。
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [{ bind: "enter", title: "Submit", group: "Dialog", run: confirm }],
  }))

  return (
    <DialogFrame context={props.context} title={props.title} submit={props.copy.settings.submit}>
      <textarea
        height={1}
        wrapMode="none"
        initialValue={`${props.initial.toString()}%`}
        placeholder="10%"
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.base}
        onContentChange={() => setText(area?.plainText ?? "")}
        ref={(input) => {
          area = input
          setTimeout(() => {
            if (!input.isDestroyed) input.focus()
          }, 1)
        }}
      />
      <Show
        when={parsed()}
        fallback={<text fg={theme.text.feedback.error.base}>{props.invalid}</text>}
      >
        {(value: () => number) => (
          <text fg={theme.text.muted}>
            {percentLabel(value(), props.windowTokens)}
          </text>
        )}
      </Show>
      <text fg={theme.text.muted}>
        {props.windowTokens === undefined
          ? props.copy.settings.windowUnknown
          : props.copy.settings.windowKnown(formatTokens(props.windowTokens))}
      </text>
      <text fg={theme.text.muted}>{props.hint}</text>
    </DialogFrame>
  )
}

/**
 * 输入：TUI 上下文 + 文案 + 初始值 + 确认回调。
 * 输出：压缩阈值的输入对话框。
 * 预期：只接受 60 ~ 95 的整数；解析失败回车不生效。
 */
function ThresholdDialog(props: {
  readonly context: Context
  readonly copy: Messages
  readonly initial: string
  readonly onConfirm: (value: number) => void
}) {
  const theme = props.context.theme
  const [text, setText] = createSignal(props.initial)
  const parsed = createMemo(() => {
    if (!/^\d{1,2}$/.test(text())) return undefined
    const value = Number(text())
    if (value < MIN_TRIGGER_PERCENT || value > MAX_TRIGGER_PERCENT) return undefined
    return value
  })
  let area: { plainText: string } | undefined

  const confirm = (): void => {
    const value = parsed()
    if (value === undefined) return
    props.onConfirm(value)
    props.context.ui.dialog.clear()
  }

  // 原生 DialogPrompt 用模态层接管回车；这里同样注册，避免 textarea 插入换行。
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [{ bind: "enter", title: "Submit", group: "Dialog", run: confirm }],
  }))

  return (
    <DialogFrame context={props.context} title={props.copy.settings.threshold} submit={props.copy.settings.submit}>
      <textarea
        height={1}
        wrapMode="none"
        initialValue={props.initial}
        placeholder="80"
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.base}
        onContentChange={() => setText(area?.plainText ?? "")}
        ref={(input) => {
          area = input
          setTimeout(() => {
            if (!input.isDestroyed) input.focus()
          }, 1)
        }}
      />
      <Show
        when={parsed()}
        fallback={<text fg={theme.text.feedback.error.base}>{props.copy.settings.thresholdInvalid}</text>}
      >
        {(value: () => number) => (
          <text fg={theme.text.muted}>{props.copy.settings.thresholdPreview(value().toString())}</text>
        )}
      </Show>
      <text fg={theme.text.muted}>{props.copy.settings.thresholdHint}</text>
    </DialogFrame>
  )
}

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
      const rpc = props.context.client.rpc(ContextRpc) as unknown as {
        settingsGet(input: { sessionID?: string }): Promise<{ resolvedWindow?: number }>
      }
      const got = await rpc.settingsGet(sessionID === undefined ? {} : { sessionID })
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
    const payload = {
      contextLimit: props.settings.contextLimit,
      triggerPercent: props.settings.triggerPercent,
      summaryBlockPercent: effectiveSummaryBlockPercent(props.settings),
      summaryTotalPercent: effectiveSummaryTotalPercent(props.settings),
      summaryLanguage: effectiveSummaryLanguage(props.settings),
      autoCompress: props.settings.autoCompress,
      enableCompressTool: props.settings.enableCompressTool,
      enableDecompressTool: props.settings.enableDecompressTool,
      showTimeline: props.settings.showTimeline,
      showBlockTokens: props.settings.showBlockTokens,
      decompressInlineMax: effectiveDecompressInlineMax(props.settings),
      decompressTempCap: effectiveDecompressTempCap(props.settings),
      decompressShowTokens: props.settings.decompressShowTokens,
    }
    try {
      // ContextRpc 是 PortableDefinition，具体方法名在类型上退化成索引签名，这里补回调用形状。
      const rpc = props.context.client.rpc(ContextRpc) as unknown as {
        settingsSet(input: {
          contextLimit: "auto" | number
          triggerPercent: number
          summaryBlockPercent: number
          summaryTotalPercent: number
          summaryLanguage: SummaryLanguage
          autoCompress: boolean
          enableCompressTool: boolean
          enableDecompressTool: boolean
          showTimeline: boolean
          showBlockTokens: boolean
          decompressInlineMax: number
          decompressTempCap: number
          decompressShowTokens: boolean
        }): Promise<unknown>
      }
      void rpc.settingsSet(payload).catch(() => undefined)
    } catch {
      // server plugin not loaded
    }
  })

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

  /** 输入：布尔设置键；输出：无；预期：翻转后重开菜单。 */
  const toggleSetting = async (
    key:
      | "autoCompress"
      | "enableCompressTool"
      | "enableDecompressTool"
      | "showTimeline"
      | "showBlockTokens"
      | "showCacheChart"
      | "showCacheLog"
      | "showSummaries"
      | "decompressShowTokens",
  ): Promise<void> => {
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
    const picked = await props.context.ui.dialog.select<string>({
      title: copy().settings.title,
      options: [
        {
          title: copy().settings.show,
          value: "show",
          footer: props.settings.enabled ? copy().settings.on : copy().settings.off,
        },
        { title: copy().settings.limit, value: "limit", footer: limitLabel(props.settings, copy(), window) },
        {
          title: copy().settings.threshold,
          value: "threshold",
          footer: `${props.settings.triggerPercent.toString()}%`,
        },
        {
          title: copy().settings.summaryBlockPercent,
          value: "blockPercent",
          footer: percentLabel(effectiveSummaryBlockPercent(props.settings), window),
        },
        {
          title: copy().settings.summaryTotalPercent,
          value: "totalPercent",
          footer: percentLabel(effectiveSummaryTotalPercent(props.settings), window),
        },
        {
          title: copy().settings.summaryLanguage,
          value: "summaryLanguage",
          footer: summaryLanguageLabel(props.settings, copy()),
        },
        {
          title: copy().settings.autoCompress,
          value: "autoCompress",
          footer: props.settings.autoCompress ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.enableCompressTool,
          value: "enableCompressTool",
          footer: props.settings.enableCompressTool ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.enableDecompressTool,
          value: "enableDecompressTool",
          footer: props.settings.enableDecompressTool ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.showTimeline,
          value: "showTimeline",
          footer: props.settings.showTimeline ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.showBlockTokens,
          value: "showBlockTokens",
          footer: props.settings.showBlockTokens ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.showCacheChart,
          value: "showCacheChart",
          footer: props.settings.showCacheChart ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.showCacheLog,
          value: "showCacheLog",
          footer: props.settings.showCacheLog ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.showSummaries,
          value: "showSummaries",
          footer: props.settings.showSummaries ? copy().settings.on : copy().settings.off,
        },
        {
          title: copy().settings.decompressInlineMax,
          value: "decompressInlineMax",
          footer: formatTokens(effectiveDecompressInlineMax(props.settings)),
        },
        {
          title: copy().settings.decompressTempCap,
          value: "decompressTempCap",
          footer: effectiveDecompressTempCap(props.settings).toString(),
        },
        {
          title: copy().settings.decompressShowTokens,
          value: "decompressShowTokens",
          footer: props.settings.decompressShowTokens ? copy().settings.on : copy().settings.off,
        },
        { title: copy().settings.language, value: "language", footer: localeLabel(props.settings, copy()) },
        { title: copy().settings.close, value: "close" },
      ],
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
