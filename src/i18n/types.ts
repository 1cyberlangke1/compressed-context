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
    readonly summaryBudget: string
    readonly summaryBudgetHint: string
    readonly summaryBudgetInvalid: string
    readonly summaryBudgetPlaceholder: string
    readonly summaryBlockChars: string
    readonly summaryBlockCharsHint: string
    readonly summaryBlockCharsInvalid: string
    readonly summaryBlockCharsPlaceholder: string
    readonly summaryTotalChars: string
    readonly summaryTotalCharsHint: string
    readonly summaryTotalCharsInvalid: string
    readonly summaryTotalCharsPlaceholder: string
    readonly summaryLanguage: string
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
