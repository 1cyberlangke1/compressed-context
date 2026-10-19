#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 和 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 触发一次 T1 compaction。
 * 预期：不读取/写入当前生产 OpenCode 的 HOME、DB、config、session 或端口。
 *
 * 用法：bun scripts/e2e-compress.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-compress-"))
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
const longText = "context ".repeat(4_000)
const assistantText = "assistant ".repeat(2_000)

/** 输入：content；输出：OpenAI 兼容的非流式响应。 */
function chatResponse(content) {
  return {
    id: "chatcmpl-e2e",
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
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return `${chunk({ role: "assistant", content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`
}

/** 输入：OpenAI 请求；输出：假 provider 的文本。 */
function fakeText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const text = messages
    .map((message) =>
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content.map((part) => part?.text ?? "").join("\n")
          : "",
    )
    .join("\n")

  if (text.includes("You are writing a checkpoint for the older part")) {
    console.log("fake: T1 instruction")
    return JSON.stringify({
      title: "E2E T1",
      goal: "verify isolated T1 compaction",
      constraints: ["no production interference"],
      decisions: ["fake provider returns a valid summary"],
      progress: { completed: ["session"], active: [], blocked: [] },
      open_items: [],
      files: [],
      facts: ["中".repeat(10_000)],
    })
  }
  if (text.includes("checkpoint at the top of the conversation contains summary blocks")) {
    console.log("fake: T2 instruction")
    return JSON.stringify({
      candidate: 1,
      title: "E2E T2",
      goal: "verify isolated T2 merge",
      constraints: ["no production interference"],
      decisions: ["merge one pair"],
      progress: { completed: ["T1"], active: [], blocked: [] },
      open_items: [],
      files: [],
      facts: ["t2 fact"],
    })
  }
  return assistantText
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
    const content = fakeText(body)
    if (body.stream === true) {
      return new Response(chatStream(content), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    return Response.json(chatResponse(content))
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
      models: { fake: { name: "Fake", limit: { context: 4_000, output: 2_000 } } },
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

/** 输入：方法/路径/body；输出：API 的 data。 */
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: basic, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`)
  }
  if (response.status === 204) return undefined
  const json = await response.json()
  return json.data ?? json
}

let port
try {
  const reader = server.stdout.getReader()
  const decoder = new TextDecoder()
  let line = ""
  while (!line.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    line += decoder.decode(value)
  }
  const first = line.split("\n")[0]
  const ready = JSON.parse(first)
  port = new URL(ready.url).port
  console.log("isolated server:", ready.url)

  // 临时 DB 里 seed 低阈值，只影响这个隔离实例。
  const pluginHex = Array.from("compressed-context")
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
    .join("")
  const db = new Database(join(root, "opencode.db"))
  const settingsKey = `plugin:${pluginHex}:settings`
  const now = Date.now()
  db.query(
    "insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)",
  ).run(
    settingsKey,
    JSON.stringify({ contextLimit: 4_000, triggerPercent: 60, summaryBudgetTokens: 5_000 }),
    now,
    now,
  )
  db.close()
  console.log("seeded plugin settings")

  const session = await api("POST", "/api/session", {
    title: "e2e",
    model: { providerID: "fake", id: "fake" },
  })
  const sessionID = session.id ?? session.sessionID
  assert.ok(sessionID, "session id missing")
  console.log("session:", sessionID)

  await api("POST", `/api/session/${sessionID}/prompt`, { text: longText })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  console.log("first prompt done")

  await api("POST", `/api/session/${sessionID}/prompt`, { text: "continue" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  console.log("second prompt done")

  await api("POST", `/api/session/${sessionID}/prompt`, { text: "continue again" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  console.log("third prompt done")

  await api("POST", `/api/session/${sessionID}/prompt`, { text: "continue once more" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  console.log("fourth prompt done")

  await api("POST", `/api/session/${sessionID}/prompt`, { text: "trigger t2" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  console.log("fifth prompt done")

  const messages = await api("GET", `/api/session/${sessionID}/message?limit=200`)
  const inbox = await api("GET", `/api/session/${sessionID}/inbox`)
  console.log("inbox:", JSON.stringify(inbox).slice(0, 1_000))
  const info = await api("GET", `/api/session/${sessionID}`)
  const context = await api("GET", `/api/session/${sessionID}/context`)
  const db2 = new Database(join(root, "opencode.db"))
  const stateRows = db2
    .query("select key, value from kv where key like '%compression:state:%'")
    .all()
  const stateValue = stateRows[0]?.value
  if (typeof stateValue === "string") {
    const parsed = JSON.parse(stateValue)
    console.log(
      "state blocks:",
      parsed.blocks?.map((block) => `${block.id}:T${block.tier}:${block.sourceBlockIds?.join("+") ?? ""}`),
      "pending:",
      parsed.pending?.id,
      "phase:",
      parsed.phase,
      "attempts:",
      parsed.attempts,
      "lastError:",
      parsed.lastError,
    )
  }
  db2.close()
  console.log("session metadata:", JSON.stringify(info.metadata ?? {}))
  console.log("message types:", (Array.isArray(messages) ? messages : []).map((item) => item.type).join(","))
  console.log("context types:", (Array.isArray(context) ? context : []).map((item) => item.type).join(","))
  const compactions = (Array.isArray(messages) ? messages : []).filter(
    (item) => item.type === "compaction" && item.status === "completed",
  )
  const latest = compactions[0]
  console.log("completed compactions:", compactions.length)
  console.log(
    "compaction summaries:",
    compactions.map((item) => String(item.summary ?? "").slice(0, 80)),
  )
  console.log("latest summary:", String(latest?.summary ?? "").slice(0, 400))
  const raw = JSON.stringify({ messages, context })
  assert.ok(raw.includes("[Compressed conversation section #b1]"), "T1 checkpoint missing")
  assert.ok(raw.includes("[Compressed conversation section #b3]"), "T2 checkpoint missing")
  assert.ok(!String(latest?.summary ?? "").includes("[Compressed conversation section #b1]"), "latest checkpoint still shows T1")
  console.log("T1 and T2 checkpoints found")
} finally {
  server.kill()
  await server.exited
  const stderr = await new Response(server.stderr).text()
  if (stderr.trim()) {
    const interesting = stderr
      .split(/\r?\n/)
      .filter((line) => /compaction|inbox|drain|session\.idle/i.test(line))
      .slice(-120)
    if (interesting.length > 0) console.error("server compaction logs:\n" + interesting.join("\n"))
  }
  fake.stop()
  await rm(root, { recursive: true, force: true })
}
