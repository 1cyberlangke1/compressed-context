#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 和 bun）。
 * 输出：复现「自动压缩进行中被用户打断后，再发消息不再触发压缩」。
 * 预期：隔离 HOME/DB/config；记录每一步事件流水；结束时打印插件 state 与 capturedRequests。
 *
 * 场景：
 *  1) 小窗口 + 大用量让自动 T1 触发（usage 90k / 窗口 100k / 阈值 80%）。
 *  2) 压缩摘要请求进行中（假 provider 让 T1 摘要挂起）调用 session.interrupt。
 *  3) 放行摘要请求，等 idle。
 *  4) 再发一条大 prompt，观察是否出现第二次 T1 请求。
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-repro-interrupt-"))
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

const password = Buffer.from(new Uint8Array(24).fill(65)).toString("base64")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const longText = "context ".repeat(750)

// 合格的 Babel 摘要正文（>200 字符），让 T1 校验通过、真的产出块。
const LONG_SUMMARY =
  "T=repro|G=verify interrupted compaction recovers\n" +
  "S[scenario]: user interrupted an in-flight automatic compaction; the next prompt must trigger a fresh T1 block.\n" +
  "F[files]: scripts/e2e-repro-interrupt.mjs drives the fake provider; src/compression/auto.ts gates re-entry.\n" +
  "K[expectations]: after interrupt, pending clears; next request with usage above threshold enqueues compaction again.\n" +
  "!edge: summary validation requires at least 200 characters, so the canned reply must exceed that bound."


// 假 provider 的行为开关：hold 表示摘要请求挂起（等外部放行）。
let holdSummary = false
let releaseSummary = () => undefined
const summaryWaiters = []

const capturedRequests = []

/** 输入：content；输出：OpenAI 兼容的 SSE 响应。 */
function chatStream(content) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-repro",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: { prompt_tokens: usagePromptTokens, completion_tokens: 1, total_tokens: usagePromptTokens + 1 },
    })}\n\n`
  return `${chunk({ role: "assistant", content }, null)}${chunk({}, "stop", {
    prompt_tokens: usagePromptTokens,
    completion_tokens: 1,
    total_tokens: usagePromptTokens + 1,
  })}data: [DONE]\n\n`
}

let usagePromptTokens = 90_000

/** 输入：请求体；输出：是否为 T1 摘要请求。 */
const isSummary = (body) => {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const text = messages
    .map((m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? "").join("\n") : ""))
    .join("\n")
  return text.includes("You are writing a checkpoint for the older part")
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
    const summary = isSummary(body)
    capturedRequests.push({
      at: new Date().toISOString().slice(11, 23),
      summary,
      held: false,
    })
    note("model", `request #${capturedRequests.length} summary=${summary}`)
    if (summary && holdSummary) {
      capturedRequests[capturedRequests.length - 1].held = true
      note("model", `request #${capturedRequests.length} HELD (waiting for release)`)
      await new Promise((resolve) => {
        summaryWaiters.push(resolve)
        releaseSummary = () => {
          const w = summaryWaiters.splice(0)
          for (const r of w) r()
        }
      })
      note("model", `request #${capturedRequests.length} released`)
    }
    const content = summary ? LONG_SUMMARY : "assistant reply"
    return new Response(chatStream(content), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  },
})

const config = {
  snapshots: false,
  compaction: { auto: false, keep: { tokens: 1_000 } },
  plugins: [{ package: repo }],
  provider: {
    fake: {
      name: "Fake Repro",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test" },
      models: {
        small: {
          name: "Small",
          limit: { context: 100_000, output: 2_000 },
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

const isWindows = process.platform === "win32"
const opencode = process.env.OPENCODE_BIN ?? (isWindows ? "opencode.cmd" : "opencode")
const server = Bun.spawn(
  isWindows
    ? ["cmd.exe", "/d", "/s", "/c", `${opencode} serve --stdio --port 0 --print-logs`]
    : [opencode, "serve", "--stdio", "--port", "0", "--print-logs"],
  { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
)

let serverStderr = ""
void (async () => {
  const reader = server.stderr.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const text = decoder.decode(value)
    serverStderr += text
    process.stderr.write(text)
  }
})()

/** 流水账。 */
const journal = []
function note(kind, detail) {
  journal.push({ at: new Date().toISOString().slice(11, 23), kind, detail: String(detail).replace(/\s+/g, " ").slice(0, 260) })
}

/** 输入：方法/路径/body；输出：API 的 data。 */
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: basic, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  note("api", `${method} ${path} -> ${response.status}`)
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`)
  if (response.status === 204) return undefined
  const json = await response.json()
  return json.data ?? json
}

const pluginHex = Array.from("compressed-context")
  .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
  .join("")

const settingsPath = join(configDir, "compressed-context.json")
const writeSettings = async (value) => {
  await writeFile(settingsPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  // 服务端设置缓存 1 秒。
  await Bun.sleep(1_100)
}

const stateFor = (sessionID) => {
  const conn = new Database(join(root, "opencode.db"))
  const key = `plugin:${pluginHex}:compression:state:${sessionID}`
  const row = conn.query("select value from kv where key = ?").get(key)
  conn.close()
  return typeof row?.value === "string" ? JSON.parse(row.value) : undefined
}

// 记录插件视角收到的全部 session 事件（SSE），用于对账 compaction.failed 是否到达。
const seenEvents = []
const startEventTap = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const events = await fetch(`http://127.0.0.1:${port}/api/event`, {
        headers: { authorization: basic, accept: "text/event-stream" },
      })
      void (async () => {
        try {
          const reader = events.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let index
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index).trim()
              buffer = buffer.slice(index + 1)
              if (!line.startsWith("data:")) continue
              try {
                const payload = JSON.parse(line.slice(5))
                if (typeof payload?.type === "string" && payload.type.startsWith("session.")) {
                  seenEvents.push({
                    at: new Date().toISOString().slice(11, 23),
                    type: payload.type,
                    sid:
                      payload.properties?.data?.sessionID ??
                      payload.properties?.sessionID ??
                      payload.data?.sessionID ??
                      "",
                  })
                }
              } catch (error) {
                // 半行/粘包：把残片留给下一轮 buffer 处理
                seenEvents.push({ at: "?", type: `parse-fail: ${line.slice(0, 60)}`, sid: "" })
              }
            }
          }
        } catch {
          // 连接被关闭：tap 结束
        }
      })()
      return
    } catch {
      await Bun.sleep(200)
    }
  }
}

const summaryState = (sessionID) => {
  const s = stateFor(sessionID)
  if (!s) return "no-state"
  return JSON.stringify({
    blocks: (s.blocks ?? []).map((b) => `T${b.tier}`),
    phase: s.phase,
    pending: s.pending ? `T${s.pending.tier}` : null,
    pendingAtRaw: s.pendingAt ?? null,
    pendingAge: s.pendingAt ? Math.round((Date.now() - s.pendingAt) / 1000) + "s" : null,
    attempts: s.attempts,
    lastError: typeof s.lastError === "string" ? s.lastError.slice(0, 80) : s.lastError,
  })
}

/** 输入：sessionID；输出：等它 idle（带超时）。 */
const waitIdle = async (sessionID, ms = 30_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const s = await api("GET", `/api/session/${sessionID}/status`).catch(() => undefined)
    if (s && typeof s === "object" && s.idle !== undefined) {
      if (s.idle) return
    } else {
      // 兜底：尝试 experimental wait
      await api("POST", `/api/experimental/session/${sessionID}/wait`).catch(() => undefined)
      return
    }
    if (Date.now() > deadline) throw new Error("waitIdle timeout")
    await Bun.sleep(100)
  }
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
  port = new URL(JSON.parse(line.split("\n")[0]).url).port
  console.log("isolated server:", port)
  await startEventTap()

  await writeSettings({
    contextLimit: 100_000,
    triggerPercent: 80,
    summaryBlockPercent: 20,
    summaryTotalPercent: 10,
    autoCompress: true,
    summaryFormat: "babel",
  })
  console.log("seeded settings")

  const created = await api("POST", "/api/session", {
    title: "repro-interrupt",
    model: { providerID: "fake", id: "small" },
  })
  const sessionID = created.id ?? created.sessionID
  console.log("session:", sessionID)

  // ---- 步骤 1：第一条消息，先不挂起，正常跑完（无压缩：90k < 80%*100k=80k? 不，90k>80k 会压）----
  // 为避免第一条就压，先用小 usage 跑一条，让 nudge baseline 建立。
  usagePromptTokens = 1_000
  await api("POST", `/api/session/${sessionID}/prompt`, { text: longText })
  await waitIdle(sessionID)
  note("state", `after msg1: ${summaryState(sessionID)}`)

  // ---- 步骤 2：把用量抬到阈值上，并让 T1 摘要请求挂起 ----
  usagePromptTokens = 90_000
  holdSummary = true
  const promptPromise = api("POST", `/api/session/${sessionID}/prompt`, { text: "second message" }).then(
    () => "done",
    (e) => `error: ${e.message}`,
  )
  // 等摘要请求被挂起
  const waitHeld = async () => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (summaryWaiters.length > 0) return
      await Bun.sleep(50)
    }
    throw new Error("summary request never held")
  }
  await waitHeld()
  note("state", `summary held; state: ${summaryState(sessionID)}`)

  // ---- 步骤 3：打断会话（压缩摘要进行中）----
  const interrupt = await api("POST", `/api/session/${sessionID}/interrupt`, {})
  note("api", `interrupt result: ${JSON.stringify(interrupt)}`)
  // 放行摘要
  holdSummary = false
  releaseSummary()
  const promptOutcome = await promptPromise
  note("api", `prompt resolved: ${promptOutcome}`)
  await waitIdle(sessionID).catch(() => note("api", "waitIdle after interrupt failed (ok)"))
  await Bun.sleep(2_000)
  note("state", `after interrupt: ${summaryState(sessionID)}`)

  // ---- 步骤 4：再发一条消息，看会不会再次触发压缩 ----
  // 打断竞态的悬空 pending 有 15 秒宽限期；先发一条（可能仍被挡），等宽限过期后再发一条验证恢复。
  const beforeCount = capturedRequests.length
  usagePromptTokens = 90_000
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "third message " + longText })
  await waitIdle(sessionID).catch(() => note("api", "waitIdle final failed (ok)"))
  await Bun.sleep(16_000)
  note("state", `before msg4: ${summaryState(sessionID)} now=${Date.now()}`)
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "fourth message " + longText })
  await waitIdle(sessionID).catch(() => note("api", "waitIdle final failed (ok)"))
  await Bun.sleep(3_000)
  note("state", `after msg4: ${summaryState(sessionID)} now=${Date.now()}`)
  // 等一拍让可能的 compaction inbox 被处理，然后再发一条触发 drain。
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "fifth message " + longText })
  await waitIdle(sessionID).catch(() => note("api", "waitIdle final failed (ok)"))
  await Bun.sleep(3_000)
  note("state", `after msg5: ${summaryState(sessionID)} now=${Date.now()}`)

  const after = capturedRequests.slice(beforeCount)
  const summaryCount = after.filter((r) => r.summary).length
  console.log("\n==== RESULT ====")
  console.log(`requests after interrupt: ${after.length}, summary requests: ${summaryCount}`)
  console.log(`final state: ${summaryState(sessionID)}`)
  console.log("session events (compaction/execution/idle):")
  console.log(`  tap captured ${seenEvents.length} session events total`)
  for (const e of seenEvents) {
    const tag = e.sid === sessionID ? "MINE" : e.sid === "" ? "?" : "other"
    if (tag !== "other") console.log(`  ${e.at} [${tag}] ${e.type}`)
  }
  process.exitCode = 0
  if (summaryCount === 0) {
    console.log("REPRODUCED: no new compression attempt after interrupted compaction")
  } else {
    console.log("NOT REPRODUCED: compression was re-attempted")
  }
} catch (error) {
  note("error", error instanceof Error ? error.stack ?? error.message : String(error))
  console.error("FATAL:", error)
  process.exitCode = 1
} finally {
  server.kill()
  await server.exited
  fake.stop(true)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  console.error(`\njournal (${journal.length}):\n` + journal.map((e) => `${e.at} ${e.kind} ${e.detail}`).join("\n"))
  const interesting = serverStderr
    .split(/\r?\n/)
    .filter((line) => /compaction|E2E|plugin/i.test(line))
    .slice(-40)
  if (interesting.length > 0) console.error("server logs:\n" + interesting.join("\n"))
}
