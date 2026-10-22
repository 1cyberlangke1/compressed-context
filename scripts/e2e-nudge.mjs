#!/usr/bin/env bun
/**
 * 输入：本机 opencode 2.x + bun。
 * 输出：隔离 HOME/DB/config 里启动 OpenCode，用假 provider 捕获两次模型请求。
 * 预期：第二次请求尾部出现 context-reminder；第三次短请求不再出现；system 未被改写；
 *       第二次跨阈值会再次提醒并累加计数；关闭自动压缩后文案改为手动调用。
 *
 * 用法：bun scripts/e2e-nudge.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-nudge-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
const xdgConfig = join(root, "xdg-config")
const xdgState = join(root, "state")
const xdgCache = join(root, "cache")
await Promise.all([
  mkdir(configDir, { recursive: true }),
  mkdir(dataDir, { recursive: true }),
  mkdir(xdgConfig, { recursive: true }),
  mkdir(xdgState, { recursive: true }),
  mkdir(xdgCache, { recursive: true }),
])

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const longText = "context ".repeat(2_000)
const requests = []

/** 输入：文本；输出：OpenAI 兼容的 message content 文本。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  }
  return ""
}

/** 输入：无；输出：OpenAI 兼容的非流式响应。 */
function chatResponse(content) {
  return {
    id: "chatcmpl-e2e-nudge",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

/** 输入：content；输出：OpenAI 兼容的 SSE 响应。 */
function chatStream(content) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e-nudge",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return `${chunk({ role: "assistant", content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`
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
    requests.push(body)
    if (body.stream === true) {
      return new Response(chatStream("ok"), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    return Response.json(chatResponse("ok"))
  },
})

const config = {
  compaction: { auto: false, keep: { tokens: 1_000 } },
  plugins: [{ package: repo }],
  provider: {
    fake: {
      name: "Fake E2E",
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
  XDG_CACHE_HOME: xdgCache,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: dataDir,
  XDG_STATE_HOME: xdgState,
}

const opencode = process.env.OPENCODE_BIN ?? "opencode.cmd"
const server = Bun.spawn(["cmd.exe", "/d", "/s", "/c", `${opencode} serve --stdio --port 0 --print-logs`], {
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

let port
let sessionID
let pluginHex

/** 输入：方法/路径/body；输出：API 的 data。 */
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: basic, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status.toString()}: ${await response.text()}`)
  }
  if (response.status === 204) return undefined
  const json = await response.json()
  return json.data ?? json
}

/** 输入：sessionID + 文本；输出：无；预期：发 prompt 并等 idle。 */
async function promptSession(id, text) {
  await api("POST", `/api/session/${id}/prompt`, { text })
  await api("POST", `/api/experimental/session/${id}/wait`)
}

/** 输入：sessionID；输出：插件 state。 */
function stateFor(id) {
  const conn = new Database(join(root, "opencode.db"))
  const key = `plugin:${pluginHex}:compression:state:${id}`
  const row = conn.query("select value from kv where key = ?").get(key)
  conn.close()
  return typeof row?.value === "string" ? JSON.parse(row.value) : undefined
}

/** 输入：请求体；输出：尾部 context-reminder 文本，没有则 undefined。 */
function nudgeOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages.at(-1)
  const text = textOf(last)
  return last?.role === "user" && text.includes("[context-reminder]") ? text : undefined
}

try {
  const reader = server.stdout.getReader()
  const decoder = new TextDecoder()
  let line = ""
  while (!line.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    line += decoder.decode(value)
  }
  const ready = JSON.parse(line.split("\n")[0])
  port = new URL(ready.url).port
  console.log("isolated server:", ready.url)

  pluginHex = Array.from("compressed-context")
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
    .join("")
  const db = new Database(join(root, "opencode.db"))
  const now = Date.now()
  db.query(
    "insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)",
  ).run(
    `plugin:${pluginHex}:settings`,
    JSON.stringify({
      contextLimit: 1_000_000,
      triggerPercent: 95,
      summaryBlockPercent: 20,
      summaryTotalPercent: 10,
      summaryFormat: "markdown",
      autoCompress: true,
      enableCompressTool: true,
      enableDecompressTool: true,
      nudgeGrowthTokens: 1_000,
    }),
    now,
    now,
  )
  db.close()

  const created = await api("POST", "/api/session", {
    title: "e2e-nudge",
    model: { providerID: "fake", id: "fake" },
  })
  sessionID = created.id ?? created.sessionID
  assert.ok(sessionID, "session id missing")

  await promptSession(sessionID, longText)
  const before = requests.length
  await promptSession(sessionID, `${longText}\nsecond turn`)
  const secondTurn = requests.slice(before)
  const nudged = secondTurn.filter((body) => nudgeOf(body) !== undefined)
  assert.ok(nudged.length > 0, "second turn must carry a context-reminder")
  const reminder = nudgeOf(nudged[0])
  assert.ok(reminder?.includes("entire current conversation flow"), "reminder must describe the whole flow")
  console.log("nudge:", reminder)

  const systemBefore = requests[0]?.messages?.[0]?.content
  const systemAfter = nudged[0]?.messages?.[0]?.content
  assert.deepEqual(systemAfter, systemBefore, "system prompt must not be rewritten")

  const afterNudge = requests.length
  await promptSession(sessionID, "continue")
  const thirdTurn = requests.slice(afterNudge)
  assert.ok(thirdTurn.length > 0, "third turn must reach the provider")
  assert.ok(thirdTurn.every((body) => nudgeOf(body) === undefined), "short third turn must not repeat the reminder")

  const state = stateFor(sessionID)
  assert.equal(state?.nudgeCount, 1, "nudge count should be one")
  assert.ok(typeof state?.nudgeBaselineTokens === "number", "baseline should be stored")
  console.log("case passed: nudge appended once at request tail, then reset")

  // 第二次跨阈值：基线已重置，再长大一次必须再提醒，且计数累加。
  const beforeSecond = requests.length
  await promptSession(sessionID, longText)
  const secondBatch = requests.slice(beforeSecond)
  const nudgedAgain = secondBatch.filter((body) => nudgeOf(body) !== undefined)
  assert.ok(nudgedAgain.length > 0, "second threshold crossing must nudge again")
  assert.equal(stateFor(sessionID)?.nudgeCount, 2, "nudge count should accumulate")
  console.log("case passed: second threshold crossing nudges again")

  // 关闭自动压缩后，文案应改为「需要时手动调用 compress」。
  const db2 = new Database(join(root, "opencode.db"))
  const now2 = Date.now()
  db2
    .query("insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)")
    .run(
      `plugin:${pluginHex}:settings`,
      JSON.stringify({
        contextLimit: 1_000_000,
        triggerPercent: 95,
        summaryBlockPercent: 20,
        summaryTotalPercent: 10,
        summaryFormat: "markdown",
        autoCompress: false,
        enableCompressTool: true,
        enableDecompressTool: true,
        nudgeGrowthTokens: 1_000,
      }),
      now2,
      now2,
    )
  db2.close()

  const beforeManual = requests.length
  await promptSession(sessionID, longText)
  const manualBatch = requests.slice(beforeManual)
  const manualNudge = manualBatch.map((body) => nudgeOf(body)).find((text) => text !== undefined)
  assert.ok(manualNudge?.includes("call compress when convenient"), "manual wording when autoCompress is off")
  console.log("case passed: manual wording after disabling auto compression")
} finally {
  server.kill()
  await server.exited
  const stderr = await new Response(server.stderr).text()
  if (stderr.trim()) {
    const interesting = stderr
      .split(/\r?\n/)
      .filter((line) => /nudge|context-reminder|loading plugin/i.test(line) && !/spawning process/.test(line))
      .slice(-20)
    if (interesting.length > 0) console.error("server nudge logs:\n" + interesting.join("\n"))
  }
  fake.stop()
  await rm(root, { recursive: true, force: true })
}
