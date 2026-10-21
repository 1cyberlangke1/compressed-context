#!/usr/bin/env bun
/**
 * 输入：本机 LM Studio 已加载 qwen/qwen3.6-35b-a3b @ 128K。
 * 输出：隔离 OpenCode 实例里跑两个真实模型用例：
 *   1. 自然触发：上下文超过阈值后自动 T1。
 *   2. 模型主动触发：模型调用 compress 工具生成 T1。
 * 预期：不读写生产 OpenCode 的 HOME、DB、config、session 或端口。
 *
 * 用法：bun scripts/e2e-local-model.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const repo = process.cwd()
const lmBase = "http://127.0.0.1:1234/v1"
const providerID = "lmstudio"
const modelID = "qwen/qwen3.6-35b-a3b"

const root = await mkdtemp(join(tmpdir(), "opencode-e2e-local-"))
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

/** 输入：无；输出：确认 LM Studio 上目标模型已加载。 */
async function assertModelLoaded() {
  const response = await fetch(`${lmBase}/models`)
  if (!response.ok) throw new Error(`LM Studio /models -> ${response.status.toString()}`)
  const json = await response.json()
  const ids = Array.isArray(json?.data) ? json.data.map((item) => item?.id) : []
  if (!ids.includes(modelID)) {
    throw new Error(`LM Studio 未加载 ${modelID}，当前模型: ${ids.join(", ") || "(none)"}`)
  }
  console.log("lm studio model:", modelID)
}

await assertModelLoaded()

const config = {
  compaction: { auto: false, keep: { tokens: 1_000 } },
  plugins: [{ package: repo }],
  provider: {
    [providerID]: {
      name: "LM Studio",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: lmBase, apiKey: "lm-studio" },
      models: {
        [modelID]: {
          name: "Qwen3.6-35B-A3B",
          limit: { context: 131_072, output: 8_192 },
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
let dbPath
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

/** 输入：sessionID；输出：messages 数组。 */
async function messagesFor(sessionID) {
  return api("GET", `/api/session/${sessionID}/message?limit=200`)
}

/**
 * 输入：sessionID + 起始消息数 + 标签。
 * 输出：无；预期：等到本次 prompt 之后出现新的 idle 消息。
 * 说明：本地模型可能超过 session.wait 的超时，所以改为轮询消息表。
 */
async function waitForIdle(sessionID, from, label, timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const messages = await messagesFor(sessionID)
    if (messages.slice(from).some((message) => message?.type === "idle")) return
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: messages=${messages.length.toString()}`)
    }
    await Bun.sleep(2_000)
  }
}

/** 输入：sessionID + 文本；输出：无；预期：发一条 prompt 并等 idle。 */
async function promptSession(sessionID, text) {
  const before = (await messagesFor(sessionID)).length
  await api("POST", `/api/session/${sessionID}/prompt`, { text })
  await waitForIdle(sessionID, before, "prompt idle")
}

/** 输入：标题；输出：新 sessionID。 */
async function newSession(title) {
  const created = await api("POST", "/api/session", {
    title,
    model: { providerID, id: modelID },
  })
  const id = created.id ?? created.sessionID
  assert.ok(id, "session id missing")
  return id
}

/** 输入：sessionID；输出：插件 state。 */
function stateFor(sessionID) {
  const conn = new Database(dbPath)
  const key = `plugin:${pluginHex}:compression:state:${sessionID}`
  const row = conn.query("select value from kv where key = ?").get(key)
  conn.close()
  return typeof row?.value === "string" ? JSON.parse(row.value) : undefined
}

/**
 * 输入：sessionID + 判定函数 + 标签 + 超时。
 * 输出：满足判定时的插件 state。
 * 预期：轮询读取临时 DB；超时抛出最后状态，不静默通过。
 */
async function waitForState(sessionID, predicate, label, timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = stateFor(sessionID)
    if (predicate(state)) return state
    if (Date.now() > deadline) {
      const snapshot = {
        phase: state?.phase,
        blocks: state?.blocks?.map((block) => `${block.id}:T${block.tier.toString()}`),
        pending: state?.pending?.id,
        attempts: state?.attempts,
        lastError: state?.lastError,
      }
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(snapshot)}`)
    }
    await Bun.sleep(2_000)
  }
}

/** 输入：无；输出：足够长、带事实的项目记录。 */
function projectChunk() {
  const facts = [
    "SUMMARY_WINDOW_RESERVE=10000 导致 8K 窗口不触发自动压缩。",
    "计划改成 summaryReserve(window)=min(10000, floor(window*0.25))。",
    "cache history 存在 ctx.storage 的 cache:history:<sessionID>，最多 10 条，按 messageID 去重。",
    "T1/T2/T3 块链保持前缀不变，压缩失败时上下文不动。",
    "本地模型 Qwen3.6-35B-A3B，128K 上下文，8GB VRAM，32GB RAM。",
  ]
  return Array.from({ length: 420 }, (_, index) => `${index.toString()}: ${facts[index % facts.length]}`).join("\n")
}

/** 输入：state；输出：可读摘要。 */
function describeState(state) {
  return {
    phase: state?.phase,
    blocks: state?.blocks?.map((block) => `${block.id}:T${block.tier.toString()}`) ?? [],
    pending: state?.pending?.id,
    attempts: state?.attempts,
    lastError: state?.lastError,
  }
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
  dbPath = join(root, "opencode.db")
  pluginHex = Array.from("compressed-context")
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
    .join("")
  console.log("isolated server:", ready.url)

  const settingsKey = `plugin:${pluginHex}:settings`
  const baseSettings = {
    contextLimit: 50_000,
    triggerPercent: 60,
    summaryBlockPercent: 20,
    summaryTotalPercent: 10,
    summaryLanguage: "zh",
    summaryFormat: process.env.SUMMARY_FORMAT ?? "markdown",
    autoCompress: true,
    enableCompressTool: true,
    enableDecompressTool: true,
  }

  /** 输入：要覆盖的设置；输出：无；预期：只改临时 DB 的插件 settings。 */
  function writeSettings(overrides) {
    const conn = new Database(dbPath)
    const at = Date.now()
    conn
      .query("insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)")
      .run(settingsKey, JSON.stringify({ ...baseSettings, ...overrides }), at, at)
    conn.close()
  }

  writeSettings({})
  console.log("seeded settings: contextLimit=50000 trigger=60%")

  /** 输入：sessionID；输出：无；预期：手动 compact 后等新的 T1 块落盘。 */
  async function compactSession(sessionID) {
    const before = stateFor(sessionID)?.blocks?.length ?? 0
    await api("POST", `/api/session/${sessionID}/compact`, {})
    await waitForState(
      sessionID,
      (state) => (state?.blocks?.length ?? 0) > before && state?.pending === undefined,
      "manual compact T1",
    )
  }

  // 用例 1：自然触发。三段各约 10K token，累计超过 30K 触发线。
  const only = process.env.CASE ?? "all"
  if (only === "all" || only === "auto") {
    const autoSession = await newSession("e2e-local-auto")
    console.log("auto session:", autoSession)
    const chunk = projectChunk()
    let autoState
    for (let index = 0; index < 4; index += 1) {
      console.log(`auto prompt ${(index + 1).toString()}/4`)
      await promptSession(
        autoSession,
        `第 ${(index + 1).toString()} 段项目记录，请只回复 OK。\n${chunk}`,
      )
      autoState = stateFor(autoSession)
      console.log("auto state:", JSON.stringify(describeState(autoState)))
      if ((autoState?.blocks?.length ?? 0) > 0) break
    }
    autoState = await waitForState(
      autoSession,
      (state) => (state?.blocks?.length ?? 0) > 0 && state?.pending === undefined,
      "natural auto T1",
    )
    assert.equal(autoState.blocks[0]?.tier, 1, "natural trigger must create a T1 block")
    assert.equal(autoState.lastError, undefined, "natural trigger must not leave lastError")
    console.log("case passed: natural auto T1", JSON.stringify(describeState(autoState)))
    console.log("auto messages:", (await messagesFor(autoSession)).length)
  }

  // 用例 2：模型主动调用 compress 工具。
  if (only === "all" || only === "tool") {
    const toolSession = await newSession("e2e-local-tool")
    console.log("tool session:", toolSession)
    const chunk = projectChunk()
    await promptSession(toolSession, `第一段项目记录，请只回复 OK。\n${chunk}`)
    await promptSession(toolSession, `第二段项目记录，请只回复 OK。\n${chunk}`)
    await promptSession(
      toolSession,
      "现在请立即调用 compress 工具，把上面的对话压缩成一个 checkpoint。只调用工具，不要用文字回答。" +
        "goal 至少 200 字，并填写 constraints、decisions、progress、facts；files 没有就留空。",
    )
    const toolState = await waitForState(
      toolSession,
      (state) => (state?.blocks?.length ?? 0) > 0 && state?.pending === undefined,
      "compress tool T1",
    )
    assert.equal(toolState.blocks[0]?.tier, 1, "compress tool must create a T1 block")
    assert.equal(toolState.lastError, undefined, "compress tool must not leave lastError")
    console.log("case passed: compress tool T1", JSON.stringify(describeState(toolState)))
    console.log("tool messages:", (await messagesFor(toolSession)).length)
  }

  // 用例 3：真实 T2→T3。前两个 T1 用高预算；第三个 T1 前把总预算压到 1%，
  // 让 T1 结束后挂 phase=t2；下一次请求合并 T2，仍超预算再合并 T3。
  if (only === "all" || only === "t2t3") {
    const session = await newSession("e2e-local-t2t3")
    console.log("t2t3 session:", session)
    const chunk = projectChunk().slice(0, 6_000)
    writeSettings({ summaryTotalPercent: 50 })

    for (let index = 1; index <= 2; index += 1) {
      await promptSession(session, `第 ${index.toString()} 段项目记录，请只回复 OK。\n${chunk}`)
      await compactSession(session)
      console.log(`t1 ${index.toString()}:`, JSON.stringify(describeState(stateFor(session))))
    }

    writeSettings({ summaryTotalPercent: 1 })
    await promptSession(session, `第 3 段项目记录，请只回复 OK。\n${chunk}`)
    await compactSession(session)
    let state = stateFor(session)
    console.log("after t1 3:", JSON.stringify(describeState(state)))
    assert.equal(state?.blocks?.length, 3, "t2t3 needs three T1 blocks")
    assert.equal(state?.phase, "t2", "low total budget must schedule T2")

    await promptSession(session, "continue")
    state = await waitForState(
      session,
      (current) =>
        (current?.blocks ?? []).some((block) => block.tier === 2) && current?.pending === undefined,
      "real T2 merge",
    )
    console.log("after T2:", JSON.stringify(describeState(state)))
    assert.equal(state.lastError, undefined, "T2 must not leave lastError")

    await promptSession(session, "continue")
    state = await waitForState(
      session,
      (current) =>
        (current?.blocks ?? []).some((block) => block.tier === 3) && current?.pending === undefined,
      "real T3 merge",
    )
    console.log("after T3:", JSON.stringify(describeState(state)))
    assert.equal(state.lastError, undefined, "T3 must not leave lastError")
    console.log("case passed: real T2 and T3 merges")
  }

  console.log("ALL LOCAL MODEL CASES PASSED")
} finally {
  server.kill()
  await server.exited.catch(() => {})
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    // Windows 上 OpenCode 子进程可能还持有临时 DB；清理失败不影响用例结果。
    console.warn("temp dir left:", root, String(error))
  }
}
