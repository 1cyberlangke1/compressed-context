#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 和 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 驱动一次多 step tool loop。
 * 预期：usage 从 6.5k 涨到 96k；84.5k 步超过 80k 阈值后，session.step.ended 触发自动压缩并生成 b1:T1。
 *       tool loop 内的每个 step usage 都要落进 cache history。
 *
 * 用法：bun scripts/e2e-tool-loop.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-tool-loop-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
for (const dir of [configDir, dataDir, join(root, "xdg-config"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true })
}

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

const LOOP_STEPS = 15
const firstUsage = 6_528
let loopCount = 0

/** 输入：无；输出：合法的小摘要 JSON。 */
function summaryJson() {
  return JSON.stringify({
    title: "Loop summary",
    goal: "verify auto compression inside tool loop",
    constraints: ["fake provider"],
    decisions: ["compress at threshold"],
    progress: { completed: ["loop"], active: [], blocked: [] },
    open_items: [],
    files: [],
    facts: ["中".repeat(400)],
  })
}

/**
 * 输入：OpenAI 请求；输出：非流式响应。
 * 预期：前 LOOP_STEPS 次返回 tool_calls（usage 递增 6k）；
 *       压缩指令返回合法摘要；loop 结束后返回 done。
 */
function handle(body) {
  const stream = body?.stream === true
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((message) => message?.role === "user")
  const lastUserText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.map((part) => part?.text ?? "").join("\n")
        : ""
  const isCheckpoint =
    lastUserText.includes("You are writing a checkpoint") ||
    lastUserText.includes("The checkpoint at the top of the conversation")

  if (isCheckpoint) {
    const content = summaryJson()
    if (stream) {
      const chunk = (delta, finish, usage) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-loop",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage === undefined ? {} : { usage }),
        })}\n\n`
      const sse =
        chunk({ role: "assistant", content }, null) +
        chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) +
        `data: [DONE]\n\n`
      return new Response(sse, { headers: { "content-type": "text/event-stream" }, status: 200 })
    }
    return Response.json({
      id: "chatcmpl-loop",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }

  if (loopCount < LOOP_STEPS) {
    loopCount += 1
    const promptTokens = firstUsage + loopCount * 6_000
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: 1,
      total_tokens: promptTokens + 1,
      prompt_tokens_details: { cached_tokens: promptTokens - 1 },
    }
    if (stream) {
      const chunk = (delta, finish, chunkUsage) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-loop",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(chunkUsage === undefined ? {} : { usage: chunkUsage }),
        })}\n\n`
      const sse =
        chunk(
          { role: "assistant", tool_calls: [{ index: 0, id: `call_${loopCount}`, function: { name: "glob", arguments: "" } }] },
          null,
        ) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ pattern: "**/*.ts" }) } }] }, null) +
        chunk({}, "tool_calls") +
        chunk({}, "stop", usage) +
        `data: [DONE]\n\n`
      return new Response(sse, { headers: { "content-type": "text/event-stream" }, status: 200 })
    }
    return Response.json({
      id: "chatcmpl-loop",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${loopCount}`,
                type: "function",
                function: { name: "glob", arguments: JSON.stringify({ pattern: "**/*.ts" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    })
  }

  const done = { prompt_tokens: firstUsage, completion_tokens: 1, total_tokens: firstUsage + 1 }
  if (stream) {
    const chunk = (delta, finish, chunkUsage) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-loop",
        object: "chat.completion.chunk",
        created: 0,
        model: "fake",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(chunkUsage === undefined ? {} : { usage: chunkUsage }),
      })}\n\n`
    return new Response(`${chunk({ role: "assistant", content: "done" }, null)}${chunk({}, "stop", done)}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    })
  }
  return Response.json({
    id: "chatcmpl-loop",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    usage: done,
  })
}

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "fake", object: "model" }] })
    }
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return new Response("not found", { status: 404 })
    }
    const body = await request.json()
    try {
      return handle(body)
    } catch (error) {
      console.log("provider error", error)
      return new Response(String(error), { status: 500 })
    }
  },
})

const config = {
  compaction: { auto: false },
  plugins: [{ package: repo }],
  provider: {
    fake: {
      name: "Fake Loop",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test" },
      models: {
        fake: {
          name: "Fake",
          limit: { context: 1_000_000, output: 2_000 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}

const env = {
  ...process.env,
  HOME: root,
  OPENCODE_CONFIG_DIR: configDir,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_PASSWORD: password,
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: dataDir,
  XDG_STATE_HOME: join(root, "state"),
}

const isWindows = process.platform === "win32"
const opencode = process.env.OPENCODE_BIN ?? (isWindows ? "opencode.cmd" : "opencode")
const server = Bun.spawn(
  isWindows
    ? ["cmd.exe", "/d", "/s", "/c", `${opencode} serve --stdio --port 0 --print-logs`]
    : [opencode, "serve", "--stdio", "--port", "0", "--print-logs"],
  {
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

let port
{
  const reader = server.stdout.getReader()
  const decoder = new TextDecoder()
  let line = ""
  while (!line.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    line += decoder.decode(value)
  }
  port = new URL(JSON.parse(line).url).port
  console.log("isolated server:", port)
}

const api = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: basic, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`)
  const text = await response.text()
  const json = text.length === 0 ? undefined : JSON.parse(text)
  return json?.data ?? json
}

const pluginHex = Array.from("compressed-context")
  .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
  .join("")
const dbPath = join(root, "opencode.db")
// 插件设置现在只读自己的 JSONC；写 DB 的旧 seed 已被忽略。
// 全局 contextLimit 已移除：窗口覆盖必须走按模型设置。
await writeFile(
  join(configDir, "compressed-context.json"),
  `${JSON.stringify(
    {
      models: { fake: { contextLimit: 100_000 } },
      triggerPercent: 80,
      summaryBlockPercent: 10,
      summaryTotalPercent: 50,
    },
    null,
    2,
  )}\n`,
  "utf8",
)
console.log("seeded settings")

const created = await api("POST", "/api/session", {
  title: "e2e-tool-loop",
  model: { providerID: "fake", id: "fake" },
})
const sessionID = created.id ?? created.sessionID
assert.ok(sessionID, "session id missing")

await api("POST", `/api/session/${sessionID}/prompt`, { text: `run the loop ${LOOP_STEPS} times` })
await api("POST", `/api/experimental/session/${sessionID}/wait`)

const readKV = (suffix) => {
  const db = new Database(dbPath, { readonly: true })
  const row = db.query("select value from kv where key = ?").get(`plugin:${pluginHex}:${suffix}`)
  db.close()
  return typeof row?.value === "string" ? JSON.parse(row.value) : undefined
}

const state = readKV(`compression:state:${sessionID}`)
const history = readKV(`cache:history:${sessionID}`)

assert.equal(loopCount, LOOP_STEPS, `provider must serve ${LOOP_STEPS} loop steps`)
assert.ok(Array.isArray(state?.blocks) && state.blocks.length > 0, "tool loop must trigger auto compression")
assert.equal(state.blocks[0]?.tier, 1, "first block must be T1")
assert.ok(
  typeof state.nudgeBaselineTokens === "number" && state.nudgeBaselineTokens > 0,
  "nudge baseline must be re-established after compression",
)

assert.ok(Array.isArray(history?.samples) && history.samples.length > 0, "step usage must be recorded in cache history")
const peakSample = [...history.samples].sort((left, right) => left.input - right.input).at(-1)
assert.ok(peakSample.input > 80_000, `cache history must reach the loop peak, got ${peakSample.input}`)
assert.ok(history.samples.every((sample) => sample.messageID.length > 0), "every sample must carry a messageID")

console.log("provider loop requests:", loopCount)
console.log("blocks:", state.blocks.map((block) => `${block.id}:T${block.tier}`).join(" "))
console.log("nudge baseline:", state.nudgeBaselineTokens)
console.log("cache samples:", history.samples.length, "peak input:", peakSample.input)
console.log("case passed: tool loop auto compression")

server.kill()
await rm(root, { recursive: true, force: true }).catch(() => undefined)
process.exit(0)
