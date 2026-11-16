import { describe, expect, it } from "vitest"

import { diagnostic, diagnosticResult, renderDiagnostic } from "../src/shared/diagnostic.ts"

/** 输入：无；输出：一条解析类诊断（有原文可指）。 */
function parseDiagnostic() {
  return diagnostic({
    tool: "compress",
    code: "BABEL_HEADER",
    summary: "line 1 is missing the '|G=<goal>' separator",
    at: "babel[1:1..1:20]",
    expected: "T=<title>|G=<goal>",
    got: "T=修复提醒判据重写",
    excerpt: "T=修复提醒判据重写",
    fix: "put the goal on line 1, e.g. T=修复提醒判据重写|G=让判据可核对",
  })
}

/** 输入：无；输出：一条状态类诊断（无原文）。 */
function stateDiagnostic() {
  return diagnostic({
    tool: "compress",
    code: "ALREADY_IN_PROGRESS",
    summary: "compression already in progress",
    expected: "no pending compaction",
    got: "pending=b2",
    fix: "wait for the current compaction, then call compress again",
  })
}

describe("diagnostic", () => {
  it("解析类诊断渲染出原文、期望、实得和修法", () => {
    const text = renderDiagnostic(parseDiagnostic())
    expect(text).toContain("ERROR: compress:")
    expect(text).toContain("(BABEL_HEADER)")
    expect(text).toContain("at: babel[1:1..1:20]")
    expect(text).toContain("expected: T=<title>|G=<goal>")
    expect(text).toContain("got: T=修复提醒判据重写")
    expect(text).toContain("excerpt: T=修复提醒判据重写")
    expect(text).toContain("fix: put the goal on line 1")
  })

  it("状态类诊断不编造行列与原文", () => {
    const text = renderDiagnostic(stateDiagnostic())
    expect(text).not.toContain("at:")
    expect(text).not.toContain("excerpt:")
    expect(text).toContain("expected: no pending compaction")
    expect(text).toContain("got: pending=b2")
  })

  it("diagnostic 不把 undefined 落成显式键", () => {
    expect(Object.keys(stateDiagnostic())).not.toContain("at")
    expect(Object.keys(stateDiagnostic())).not.toContain("excerpt")
  })

  it("diagnosticResult 同时产出 output / content / metadata", () => {
    const result = diagnosticResult(parseDiagnostic(), { status: "error" })
    expect(result.output.status).toBe("error")
    expect(result.output.error).toBe("line 1 is missing the '|G=<goal>' separator")
    expect(result.output.code).toBe("BABEL_HEADER")
    expect(result.output.got).toBe("T=修复提醒判据重写")
    expect(result.content).toContain("ERROR: compress:")
    expect(result.metadata["error"]).toBe(true)
    expect(result.metadata["code"]).toBe("BABEL_HEADER")
  })

  it("诊断格式只在一处定义：改 renderDiagnostic 文本，所有调用点同步", () => {
    const result = diagnosticResult(stateDiagnostic(), {})
    expect(result.content).toBe(renderDiagnostic(stateDiagnostic()))
  })
})
