import type { CategoryKey } from "../stats.ts"

/**
 * 面板文案。
 *
 * 源码里只引用键名，所有用户可见文字都来自语言文件。
 */
export interface Messages {
  readonly title: string
  readonly labels: Readonly<Record<CategoryKey, string>>
  readonly approximate: string
  readonly terminal: string
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
    readonly threshold: string
    readonly thresholdHint: string
    readonly thresholdInvalid: string
    readonly thresholdPreview: (value: string) => string
    readonly summaryBlockPercent: string
    readonly summaryBlockPercentHint: string
    readonly summaryTotalPercent: string
    readonly summaryTotalPercentHint: string
    readonly summaryPercentInvalid: string
    readonly windowKnown: (value: string) => string
    readonly windowUnknown: string
    readonly summaryLanguage: string
    readonly autoCompress: string
    readonly enableCompressTool: string
    readonly enableDecompressTool: string
    readonly showTimeline: string
    readonly showBlockTokens: string
    readonly showCacheChart: string
    readonly showCacheLog: string
    readonly showSummaries: string
    readonly decompressInlineMax: string
    readonly decompressInlineMaxHint: string
    readonly decompressInlineMaxInvalid: string
    readonly decompressTempCap: string
    readonly decompressTempCapHint: string
    readonly decompressTempCapInvalid: string
    readonly decompressShowTokens: string
    readonly submit: string
    readonly language: string
    readonly auto: string
    readonly on: string
    readonly off: string
    readonly close: string
  }
  readonly languages: {
    readonly zh: string
    readonly en: string
  }
}
