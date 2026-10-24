import type { CategoryKey } from "../shared/stats.ts"

/**
 * 面板文案。
 *
 * 源码里只引用键名，所有用户可见文字都来自语言文件。
 */
export interface Messages {
  readonly title: string
  readonly labels: Readonly<Record<CategoryKey, string>>
  readonly approximate: string
  readonly cacheTitle: string
  readonly cacheChart: string
  readonly cacheLog: string
  readonly cacheInput: string
  readonly cacheOutput: string
  readonly cacheCached: string
  readonly cacheHit: string
  readonly summariesTitle: string
  readonly noData: string
  readonly command: {
    readonly title: string
    readonly description: string
    readonly group: string
  }
  readonly nativeCompaction: {
    readonly title: string
    readonly disable: string
    readonly keep: string
    readonly dismiss: string
    readonly disabled: string
    readonly writeFailed: (error: string) => string
  }
  readonly settings: {
    readonly title: string
    readonly show: string
    readonly limit: string
    readonly limitAuto: string
    readonly limitCustom: string
    readonly limitHint: string
    readonly limitInvalid: string
    readonly limitPlaceholder: string
    readonly limitPreview: (value: string) => string
    readonly limitCapped: (requested: string, actual: string) => string
    readonly threshold: string
    readonly thresholdHint: string
    readonly thresholdInvalid: string
    readonly thresholdPreview: (value: string) => string
    readonly nudgeGrowth: string
    readonly nudgeGrowthHint: string
    readonly nudgeGrowthInvalid: string
    readonly summaryBlockPercent: string
    readonly summaryBlockPercentHint: string
    readonly summaryTotalPercent: string
    readonly summaryTotalPercentHint: string
    readonly summaryPercentInvalid: string
    readonly windowKnown: (value: string) => string
    readonly windowUnknown: string
    readonly summaryLanguage: string
    readonly summaryFormat: string
    readonly summaryFormatJson: string
    readonly summaryFormatMarkdown: string
    readonly summaryFormatBabel: string
    readonly autoCompress: string
    readonly enableCompressTool: string
    readonly enableDecompressTool: string
    readonly showTimeline: string
    readonly showBlockTokens: string
    readonly showCacheChart: string
    readonly showCacheLog: string
    readonly showSummaries: string
    readonly categories: {
      readonly defaults: string
      readonly summary: string
      readonly switches: string
      readonly decompress: string
      readonly interface: string
    }
    readonly sectionModel: string
    readonly allOn: string
    readonly modelCurrent: string
    readonly modelOverrides: string
    readonly modelsConfigured: (count: number) => string
    readonly modelPicker: string
    readonly modelPickerHint: string
    readonly modelPickerNameOnly: (providers: number) => string
    readonly modelScopeTitle: string
    readonly modelScopeExact: (label: string) => string
    readonly modelScopeAll: (id: string, providers: number) => string
    readonly overrideInherited: (value: string) => string
    readonly overrideSet: (value: string) => string
    readonly overrideAdd: string
    readonly overrideNone: string
    readonly overrideResetAll: string
    readonly overrideDelete: string
    readonly modelConfigured: string
    readonly overrideInheritAction: string
    readonly overrideCustom: string
    readonly decompressInlineMax: string
    readonly decompressInlineMaxHint: string
    readonly decompressInlineMaxInvalid: string
    readonly decompressTempCap: string
    readonly decompressTempCapHint: string
    readonly decompressTempCapInvalid: string
    readonly decompressTempMaxAgeHours: string
    readonly decompressTempMaxAgeHoursHint: string
    readonly decompressTempMaxAgeHoursInvalid: string
    readonly decompressShowTokens: string
    readonly submit: string
    readonly language: string
    readonly auto: string
    readonly on: string
    readonly off: string
  }
  readonly modelPanel: {
    readonly noModel: string
    readonly window: string
    readonly windowNative: (native: string) => string
    readonly windowUnknown: string
    readonly wrap: (value: string) => string
    readonly sourceGlobal: string
    readonly sourceName: string
    readonly sourceExact: string
    readonly icons: {
      readonly threshold: string
      readonly window: string
      readonly block: string
      readonly total: string
      readonly nudge: string
    }
  }
  readonly languages: {
    readonly zh: string
    readonly en: string
  }
}
