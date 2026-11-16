/**
 * 编译器式工具诊断：把工具失败从散落各处的字符串收成结构化数据。
 *
 * 输入：诊断字段；输出：Diagnostic 及模型文本 / 工具返回体。
 * 预期：A 类（解析错误，有原文可指）带 at/expected/got/excerpt；
 *       B 类（状态冲突，无原文）不带 at/excerpt，但用 expected/got 说清期望状态与实得状态。
 *       错误文案只在 renderDiagnostic 一处生成，工具层不再自己拼句子。
 */

/**
 * 一条诊断。
 * - tool/code/summary 必填；summary 是核心一句，等于 output.error，也是 content 首行。
 * - at/expected/got/excerpt/fix 可选；A 类给全，B 类不给 at/excerpt。
 */
export interface Diagnostic {
  readonly tool: string
  readonly code: string
  readonly summary: string
  readonly at?: string
  readonly expected?: string
  readonly got?: string
  readonly excerpt?: string
  readonly fix?: string
}

/**
 * 输入：诊断各字段（可选字段允许省略，不允许显式 undefined）。
 * 输出：Diagnostic；undefined 字段不落成显式键，兼容 exactOptionalPropertyTypes。
 */
export function diagnostic(input: {
  readonly tool: string
  readonly code: string
  readonly summary: string
  readonly at?: string
  readonly expected?: string
  readonly got?: string
  readonly excerpt?: string
  readonly fix?: string
}): Diagnostic {
  return {
    tool: input.tool,
    code: input.code,
    summary: input.summary,
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.got === undefined ? {} : { got: input.got }),
    ...(input.excerpt === undefined ? {} : { excerpt: input.excerpt }),
    ...(input.fix === undefined ? {} : { fix: input.fix }),
  }
}

/**
 * 输入：诊断。
 * 输出：模型读到的多行文本（宿主把 content 而不是 output 发给模型，见 core/src/tool/runtime.ts）。
 * 预期：首行 `ERROR: <tool>: <summary> (<code>)`，随后按字段是否存在追加缩进细节行。
 */
export function renderDiagnostic(d: Diagnostic): string {
  const lines = [`ERROR: ${d.tool}: ${d.summary} (${d.code})`]
  if (d.at !== undefined) lines.push(`  at: ${d.at}`)
  if (d.expected !== undefined) lines.push(`  expected: ${d.expected}`)
  if (d.got !== undefined) lines.push(`  got: ${d.got}`)
  if (d.excerpt !== undefined) lines.push(`  excerpt: ${d.excerpt}`)
  if (d.fix !== undefined) lines.push(`  fix: ${d.fix}`)
  return lines.join("\n")
}

/** 诊断写进 output 的字段；error 保留核心一句以兼容既有断言，其余为结构化补充。 */
export interface DiagnosticOutput {
  readonly error: string
  readonly code: string
  readonly at?: string
  readonly expected?: string
  readonly got?: string
  readonly excerpt?: string
  readonly fix?: string
}

/** 输入：诊断 + 字段；输出：DiagnosticOutput；预期：undefined 字段不落成显式键。 */
function diagnosticOutput(d: Diagnostic): DiagnosticOutput {
  return {
    error: d.summary,
    code: d.code,
    ...(d.at === undefined ? {} : { at: d.at }),
    ...(d.expected === undefined ? {} : { expected: d.expected }),
    ...(d.got === undefined ? {} : { got: d.got }),
    ...(d.excerpt === undefined ? {} : { excerpt: d.excerpt }),
    ...(d.fix === undefined ? {} : { fix: d.fix }),
  }
}

/**
 * 输入：诊断 + 工具自定义的 output 基础字段（如 compress 的 `status`）。
 * 输出：工具 execute 返回体；output 合并诊断字段、content 取渲染文本、metadata 标 error/code。
 * 预期：各工具失败点只调这一个函数，错误文案不再在工具层重复。
 */
export function diagnosticResult<T extends Record<string, unknown>>(
  d: Diagnostic,
  output: T,
): {
  readonly output: T & DiagnosticOutput
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
} {
  return {
    output: { ...output, ...diagnosticOutput(d) },
    content: renderDiagnostic(d),
    metadata: {
      error: true,
      code: d.code,
      ...(d.at === undefined ? {} : { at: d.at }),
    },
  }
}
