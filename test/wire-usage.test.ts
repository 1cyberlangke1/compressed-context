import { describe, expect, it } from "vitest"

import { usageFromWireBody } from "../src/shared/wire-usage.ts"

describe("usageFromWireBody", () => {
  it("解析 OpenAI Chat 的 SSE 最终分片", () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":800}}}',
      "",
      "data: [DONE]",
    ].join("\n")
    expect(usageFromWireBody(body)).toEqual({
      input: 200,
      output: 50,
      reasoning: 0,
      cache: { read: 800, write: 0 },
    })
  })

  it("解析 Anthropic：message_start 的输入与 message_delta 的输出合并", () => {
    const body = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":800,"cache_creation_input_tokens":100,"output_tokens":1}}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","usage":{"output_tokens":300}}',
      "",
    ].join("\n")
    expect(usageFromWireBody(body)).toEqual({
      input: 25,
      output: 300,
      reasoning: 0,
      cache: { read: 800, write: 100 },
    })
  })

  it("解析 OpenAI Responses 的 response.completed", () => {
    const body = [
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      "",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":200,"input_tokens_details":{"cached_tokens":900}}}}',
    ].join("\n")
    expect(usageFromWireBody(body)).toEqual({
      input: 100,
      output: 200,
      reasoning: 0,
      cache: { read: 900, write: 0 },
    })
  })

  it("解析 Gemini 的 usageMetadata", () => {
    const body =
      'data: {"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":50,"thoughtsTokenCount":10,"cachedContentTokenCount":600}}'
    expect(usageFromWireBody(body)).toEqual({
      input: 400,
      output: 60,
      reasoning: 0,
      cache: { read: 600, write: 0 },
    })
  })

  it("裸 JSON 响应也能解析", () => {
    const body = '{"usage":{"prompt_tokens":100,"completion_tokens":10}}'
    expect(usageFromWireBody(body)).toEqual({
      input: 100,
      output: 10,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
  })

  it("兼容 DeepSeek 的 prompt_cache_hit_tokens", () => {
    const body = '{"usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_cache_hit_tokens":750}}'
    expect(usageFromWireBody(body)).toEqual({
      input: 250,
      output: 10,
      reasoning: 0,
      cache: { read: 750, write: 0 },
    })
  })

  it("没有任何 usage 时返回 undefined", () => {
    expect(usageFromWireBody("")).toBeUndefined()
    expect(usageFromWireBody("data: [DONE]")).toBeUndefined()
    expect(usageFromWireBody('{"choices":[{"delta":{"content":"hi"}}]}')).toBeUndefined()
    expect(usageFromWireBody("not json at all")).toBeUndefined()
  })

  it("usage 全为 0 时返回 undefined，避免写空记录", () => {
    expect(
      usageFromWireBody('{"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":0}}}'),
    ).toBeUndefined()
  })
})
