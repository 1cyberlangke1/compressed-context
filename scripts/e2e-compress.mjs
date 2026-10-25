#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 和 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 触发一次 T1 compaction。
 * 预期：不读取/写入当前生产 OpenCode 的 HOME、DB、config、session 或端口。
 *
 * 用法：bun scripts/e2e-compress.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
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
const longText = "context ".repeat(750)
const assistantText = "assistant ".repeat(200)

/** 输入：content；输出：OpenAI 兼容的非流式响应。 */
function chatResponse(content) {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usagePromptTokens === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: usagePromptTokens,
            completion_tokens: 1,
            total_tokens: usagePromptTokens + 1,
          },
        }),
  }
}

/** 输入：content；输出：OpenAI 兼容的 SSE 响应。 */
function chatStream(content) {
  const chunk = (delta, finish, usage) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`
  const usage =
    usagePromptTokens === undefined
      ? undefined
      : {
          prompt_tokens: usagePromptTokens,
          completion_tokens: 1,
          total_tokens: usagePromptTokens + 1,
        }
  return `${chunk({ role: "assistant", content }, null)}${chunk({}, "stop", usage)}data: [DONE]\n\n`
}

/** 输入：OpenAI 请求；输出：假 provider 的文本。 */
let mode = "normal"
let usagePromptTokens
let t1Attempts = 0
let t2Attempts = 0
let toolPromptCount = 0
const prompts = []

/** 输入：无；输出：小摘要。 */
function smallSummary() {
  return JSON.stringify({
    title: "E2E small",
    goal: "verify fallback",
    constraints: ["no production interference"],
    decisions: ["fallback summary"],
    progress: { completed: [], active: [], blocked: [] },
    open_items: [],
    files: [],
    facts: ["small fact"],
  })
}

/** 输入：工具调用；输出：OpenAI 兼容的 tool_calls SSE。 */
function toolStream(tool) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-tool",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return `${chunk(
    {
      tool_calls: [
        {
          index: 0,
          id: `call_tool_${toolPromptCount.toString()}`,
          function: { name: tool.name, arguments: "" },
        },
      ],
    },
    null,
  )}${chunk(
    {
      tool_calls: [{ index: 0, function: { arguments: tool.arguments } }],
    },
    null,
  )}${chunk({}, "tool_calls")}data: [DONE]\n\n`
}

/** 输入：工具调用；输出：OpenAI 兼容的 tool_calls 响应。 */
function toolResponse(tool) {
  return {
    id: "chatcmpl-tool",
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
            { id: "call_tool_1", type: "function", function: { name: tool.name, arguments: tool.arguments } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

/** 输入：OpenAI 请求；输出：compress / decompress 工具调用或 undefined。 */
let decompressTriggered = false
function fakeToolCall(body) {
  if (mode !== "tool-compress" && mode !== "tool-decompress") return undefined
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const allUserText = messages
    .filter((message) => message?.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => part?.text ?? "").join("\n")
          : "",
    )
    .join("\n")
  const allText = messages
    .map((message) =>
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content.map((part) => part?.text ?? "").join("\n")
          : "",
    )
    .join("\n")
  // 防止 checkpoint 摘要轮被误判成工具轮
  if (allUserText.includes("You are writing a checkpoint")) return undefined
  const wantsDecompress = allUserText.includes("use decompress tool")
  const wantsCompress = allUserText.includes("use compress tool")
  if (!wantsDecompress && !wantsCompress) return undefined

  toolPromptCount += 1
  console.log("fakeToolCall", { toolPromptCount, lastUser: allUserText.slice(-80) })
  // 保险：任何判断失效都不允许无限调用工具。
  if (toolPromptCount > 8) return undefined

  // decompress 一次性：触发过一次（无论成败）就不再返回 decompress 调用，防死循环
  if (wantsDecompress && !decompressTriggered) {
    decompressTriggered = true
    console.log("fakeToolCall returning decompress")
    return {
      name: "decompress",
      arguments: JSON.stringify({ block: "b1", full: true }),
    }
  }
  // compress 只在用户明确要求且从未成功过时触发；排队成功后由 tool result 文本兜底
  if (wantsCompress && !allText.includes("queued compression b1")) {
    console.log("fakeToolCall returning compress")
    return {
      name: "compress",
      arguments: JSON.stringify({
        title: "Tool T1",
        markdown: `# Tool T1\n## Goal\nverify compress tool\n## Facts\n- ${"x".repeat(300)}`,
      }),
    }
  }
  return undefined
}

/**
 * 输入：合并指令文本。
 * 输出：提示里声明的最大候选块数（至少 1）。
 * 预期：假模型照真实模型的做法「能合多少合多少」，但必须落在候选范围内；
 *       越界编号现在会被插件判失败，所以不能写死一个 9。
 *       上限来自提示词里那句 `Decide how many blocks to merge: from 1 to N.`。
 */
function maxCandidate(text) {
  const match = /Decide how many blocks to merge: from 1 to (\d+)/.exec(text)
  return match === null ? 1 : Number(match[1])
}

function fakeText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUserMessage = [...messages].reverse().find((message) => message?.role === "user")
  const lastUser =
    typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content
      : Array.isArray(lastUserMessage?.content)
        ? lastUserMessage.content.map((part) => part?.text ?? "").join("\n")
        : ""
  prompts.push(lastUser)
  if (mode === "t3-chain") {
    console.log(
      "t3-chain prompt:",
      JSON.stringify(lastUser.slice(0, 220)),
      "| role count:",
      messages.length,
    )
  }

  const totalChars = messages.reduce((sum, message) => {
    const content = message?.content
    if (typeof content === "string") return sum + content.length
    if (Array.isArray(content)) {
      return sum + content.reduce((inner, part) => inner + (typeof part?.text === "string" ? part.text.length : 0), 0)
    }
    return sum
  }, 0)
  // 假 provider 像真实模型一样遵守提示里的字符上限；小窗口的块上限只有 4000。
  const maxMatch = /under (\d+) characters/.exec(lastUser)
  const charLimit = maxMatch ? Number(maxMatch[1]) : 20_000
  const factChars = Math.max(200, Math.min(8_000, charLimit - 2_500, totalChars - 2_000))

  // 假模型选择候选数：merge-all 表示「能合多少合多少」，其余场景按 2 个前缀合。
  const maxC = maxCandidate(lastUser)
  if (mode === "short") return "ok"
  if (lastUser.includes("Babel")) {
    if (lastUser.includes("You are writing a checkpoint for the older part")) {
      console.log("fake: Babel T1 instruction")
      return `T=Babel T1|G=verify babel checkpoint\nD ${"中".repeat(250)}`
    }
    if (lastUser.includes("checkpoint at the top of the conversation contains summary blocks")) {
      console.log("fake: Babel T2/T3 instruction")
      return `c=${mode === "merge-all" ? maxC : Math.min(1, maxC)}\nT=Babel merged|G=verify babel merge\nD ${"中".repeat(200)}`
    }
  }
  if (mode === "retry-t1" && lastUser.includes("You are writing a checkpoint for the older part")) {
    t1Attempts += 1
    if (t1Attempts === 1) return "not json"
  }
  if (mode === "invalid-t1" && lastUser.includes("You are writing a checkpoint for the older part")) {
    return "not json"
  }
  if (mode === "bad-shape-t1" && lastUser.includes("You are writing a checkpoint for the older part")) {
    return JSON.stringify({ title: "bad", goal: "" })
  }
  if (mode === "retry-t2" && lastUser.includes("checkpoint at the top of the conversation")) {    t2Attempts += 1
    if (t2Attempts === 1) return "not json"
  }
  if (mode === "invalid-t2" && lastUser.includes("Block group")) {
    return "not json"
  }
  if (mode === "invalid-t2" && lastUser.includes("Sources:")) {
    return smallSummary()
  }

  if (lastUser.includes("You are writing a checkpoint for the older part")) {
    console.log("fake: T1 instruction")
    return JSON.stringify({
      title: "E2E T1",
      goal: "verify isolated T1 compaction",
      constraints: ["no production interference"],
      decisions: ["fake provider returns a valid summary"],
      progress: { completed: ["session"], active: [], blocked: [] },
      open_items: [],
      files: [],
      facts: ["中".repeat(factChars)],
    })
  }
  if (lastUser.includes("checkpoint at the top of the conversation contains summary blocks")) {
    console.log("fake: T2 instruction")
    // t3-chain 模式：合并摘要保持巨大（6000 CJK ≈ 6000 token），逼出 T2→T3 连续合并；
    // long-session 模式：3000 CJK ≈ 3000 token，模拟真实会话里「合并后明显变小」的情况。
    const bigFact =
      mode === "t3-chain"
        ? "中".repeat(Math.max(200, charLimit - 2_500))
        : mode === "long-session"
          ? "中".repeat(3_000)
          : "t2 fact"
    return JSON.stringify({
      candidate: mode === "merge-all" ? maxC : Math.min(2, maxC),
      title: "E2E T2",
      goal: "verify isolated T2 merge",
      constraints: ["no production interference"],
      decisions: ["merge the requested prefix"],
      progress: { completed: ["T1"], active: [], blocked: [] },
      open_items: [],
      files: [],
      facts: [bigFact],
    })
  }
  return assistantText
}

/** 假 provider 捕获到的 compress 工具定义；用来断言切换摘要格式后工具真的变了。 */
let lastCompressTool

/** 输入：任意值；输出：单行短文本。预期：流水账每行不超过 max 字符，避免日志被正文淹没。 */
const brief = (value, max = 260) => String(value).replace(/\s+/g, " ").slice(0, max)

/** 流水账上限：只留最近 400 条，长跑不吃内存。 */
const JOURNAL_MAX = 400
/** 失败时必须能看懂发生了什么，所以模型请求/prompt/compact/状态变化都按时间顺序记在这里。 */
const journal = []
/** 输入：事件类型 + 细节；输出：无；预期：追加一条带毫秒时间戳的流水账。 */
function note(kind, detail) {
  journal.push({ at: new Date().toISOString().slice(11, 23), kind, detail: brief(detail) })
  if (journal.length > JOURNAL_MAX) journal.shift()
}

/**
 * 输入：模型收到的最后一条 user 文本。
 * 输出：T1 / merge / babel / chat 分类。
 * 预期：只用于诊断「这一刀到底在做什么」，不参与任何断言。
 */
function classifyPrompt(text) {
  if (text.includes("You are writing a checkpoint for the older part")) return "T1"
  if (text.includes("checkpoint at the top of the conversation contains summary blocks")) return "merge"
  if (text.includes("Babel")) return "babel"
  return "chat"
}

/** 每个会话上一次记录的状态签名；用来只在状态真的变化时写流水账。 */
const lastStateSignature = new Map()

/** 输入：消息文本标记；输出：携带该标记的最近请求的工具名列表。 */
const capturedRequests = []
function capturedToolNames(marker) {
  for (let index = capturedRequests.length - 1; index >= 0; index -= 1) {
    if (capturedRequests[index].text.includes(marker)) return capturedRequests[index].names
  }
  return []
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
    if (Array.isArray(body.tools)) {
      const found = body.tools.find((item) => (item?.function?.name ?? item?.name) === "compress")
      if (found !== undefined) {
        lastCompressTool = {
          description: found.function?.description ?? found.description,
          parameters: found.function?.parameters ?? found.parameters,
        }
      }
      // 记录每次请求的工具名与全文，供「子代理不带压缩工具」断言按标记查询。
      const messages = Array.isArray(body?.messages) ? body.messages : []
      const allText = messages
        .map((message) =>
          typeof message?.content === "string"
            ? message.content
            : Array.isArray(message?.content)
              ? message.content.map((part) => part?.text ?? "").join("\n")
              : "",
        )
        .join("\n")
      const names = body.tools.map((item) => item?.function?.name ?? item?.name)
      capturedRequests.push({
        text: allText,
        names,
        session: request.headers.get("x-opencode-session-id") ?? "unknown",
        kind: request.headers.get("x-opencode-parent-session-id") === undefined ? "primary" : "child-of-parent",
      })
    }
    if (mode === "tool-compress" || mode === "tool-decompress") {
      const names = Array.isArray(body.tools)
        ? body.tools.map((item) => item?.function?.name ?? item?.name)
        : body.tools
      console.log("tool request tools", JSON.stringify(names))
    }
    const tool = fakeToolCall(body)
    if (tool !== undefined) {
      if (body.stream === true) {
        return new Response(toolStream(tool), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }
      return Response.json(toolResponse(tool))
    }
    const content = fakeText(body)
    note(
      "model",
      `session=${request.headers.get("x-opencode-session-id") ?? "?"} ` +
        `kind=${classifyPrompt(prompts.at(-1) ?? "")} reply=${content.length}ch usage=${usagePromptTokens}`,
    )
    if (body.stream === true) {
      return new Response(chatStream(content), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    return Response.json(chatResponse(content))
  },
})

const config = {
  snapshots: false,
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
        // 小上下文模型：让第一个 case 在真实参数下几轮就能压出 T2，不需要跑几十轮。
        small: {
          name: "Small",
          limit: { context: 20_000, output: 2_000 },
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
  {
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

// 服务端日志转到 stderr，插件报错和 debug 才不会闷在管道里。
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

/** 输入：方法/路径/body；输出：API 的 data。 */
async function api(method, path, body) {
  const started = Date.now()
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: basic, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (method === "POST") note("api", `${path} -> ${response.status} in ${Date.now() - started}ms`)
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

  // 插件设置只读自己的 JSONC；写 DB 的旧 seed 已失效。
  const pluginHex = Array.from("compressed-context")
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
    .join("")
  const settingsPath = join(configDir, "compressed-context.json")
  const writeSettingsFile = async (value) => {
    await writeFile(settingsPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    // 服务端设置缓存 1 秒；等过期再发 prompt，避免读到上一组设置。
    await Bun.sleep(1_100)
  }
  await writeSettingsFile({
    contextLimit: 50_000,
    triggerPercent: 60,
    summaryBlockPercent: 20,
    summaryTotalPercent: 10,
  })
  console.log("seeded plugin settings")

  /**
   * 输入：全部摘要百分比 + 窗口 + 阈值 + 额外字段。
   * 输出：无。
   * 预期：只改隔离配置目录的插件 JSONC；单条默认 20%，可用 extra.summaryBlockPercent 覆盖。
   */
  const setSettings = async (totalPercent, contextLimit = 50_000, triggerPercent = 60, extra = {}) => {
    await writeSettingsFile({
      contextLimit,
      triggerPercent,
      summaryBlockPercent: 20,
      summaryTotalPercent: totalPercent,
      // 每个 case 的设置必须完整重写：autoCompress 等开关不随 extra 传就回默认，
      // 否则上一个 case 关掉的开关会泄漏到后续所有 case。
      autoCompress: true,
      ...extra,
    })
  }

  /** 输入：标题 + 可选父 session + 可选模型；输出：新 sessionID。 */
  const newSession = async (title, parentID, modelID = "small") => {
    const created = await api("POST", "/api/session", {
      title,
      ...(parentID === undefined ? {} : { parentID }),
      model: { providerID: "fake", id: modelID },
    })
    const id = created.id ?? created.sessionID
    assert.ok(id, "session id missing")
    return id
  }

  /** 输入：sessionID；输出：无；预期：等 session idle。 */
  const waitSession = async (sessionID) => {
    await api("POST", `/api/experimental/session/${sessionID}/wait`)
  }

  /**
   * 输入：sessionID + 谓词 + 标签。
   * 输出：谓词满足时的插件 state。
   * 预期：事件驱动——挂 /api/event SSE，等到该会话的 compaction.ended / idle /
   *       execution.succeeded 再检查谓词，最多一轮 10 秒兜底；不猜固定 sleep。
   */
  const waitForStateEvent = async (sessionID, predicate, label) => {
    const deadline = Date.now() + 10_000
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`event timeout: ${label}`)), 10_000)
    })
    const check = async () => {
      const state = stateFor(sessionID)
      if (predicate(state)) {
        clearTimeout(timer)
        return state
      }
      return undefined
    }
    const immediate = await check()
    if (immediate !== undefined) return immediate
    const events = await fetch(`http://127.0.0.1:${port}/api/event`, {
      headers: { authorization: basic, accept: "text/event-stream" },
    })
    const reader = events.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (Date.now() < deadline) {
        const raced = await Promise.race([check(), timeout])
        if (raced !== undefined) return raced
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        if (!buffer.includes(sessionID)) continue
        if (/compaction\.ended|compaction\.failed|session\.idle|execution\.succeeded/.test(buffer)) {
          buffer = ""
          const done2 = await check()
          if (done2 !== undefined) return done2
        }
      }
    } finally {
      clearTimeout(timer)
      void reader.cancel().catch(() => undefined)
    }
    throw new Error(`event wait failed: ${label}`)
  }

  /** 输入：sessionID + 文本；输出：无；预期：发一条 prompt 并等 idle。 */
  const promptSession = async (sessionID, text) => {
    await api("POST", `/api/session/${sessionID}/prompt`, { text })
    await waitSession(sessionID)
  }

  /** 输入：sessionID；输出：插件 state。 */
  const stateFor = (sessionID) => {
    const conn = new Database(join(root, "opencode.db"))
    const key = `plugin:${pluginHex}:compression:state:${sessionID}`
    const row = conn.query("select value from kv where key = ?").get(key)
    conn.close()
    const state = typeof row?.value === "string" ? JSON.parse(row.value) : undefined
    // 只有状态真的变了才写一条，否则 waitForState 每 20ms 轮询会把流水账刷满。
    const signature = JSON.stringify({
      blocks: (state?.blocks ?? []).map((block) => `${block.id}:T${block.tier}:${block.height}`),
      phase: state?.phase,
      pending: state?.pending?.id,
      attempts: state?.attempts,
      distillRounds: state?.distillRounds,
      lastError: state?.lastError,
    })
    if (lastStateSignature.get(sessionID) !== signature) {
      lastStateSignature.set(sessionID, signature)
      note("state", `${sessionID.slice(0, 12)} ${signature}`)
    }
    return state
  }

  /**
   * 输入：sessionID + 期望块数 + 标签。
   * 输出：断言通过时的 state。
   * 预期：失败信息里带实际块列表、phase、pending、attempts、lastError，
   *       这样「expected 1 got 2」时能直接看到是哪两块、当时在合并还是在压 T1。
   */
  const assertBlockCount = (sessionID, expected, label) => {
    const state = stateFor(sessionID)
    const actual = JSON.stringify({
      blocks: (state?.blocks ?? []).map((block) => `${block.id}:T${block.tier}:{h${block.height}}`),
      phase: state?.phase,
      pending: state?.pending?.id,
      attempts: state?.attempts,
      distillRounds: state?.distillRounds,
      lastError: state?.lastError,
    })
    assert.equal(state?.blocks?.length, expected, `${label} — actual ${actual}`)
    return state
  }

  /** 输入：sessionID；输出：插件持久化的缓存命中历史。 */
  const cacheHistoryFor = (sessionID) => {
    const conn = new Database(join(root, "opencode.db"))
    const key = `plugin:${pluginHex}:cache:history:${sessionID}`
    const row = conn.query("select value from kv where key = ?").get(key)
    conn.close()
    return typeof row?.value === "string" ? JSON.parse(row.value) : undefined
  }

  /** 输入：sessionID + state；输出：无；预期：只改临时 DB 的插件状态。 */
  const setState = (sessionID, state) => {
    const conn = new Database(join(root, "opencode.db"))
    const key = `plugin:${pluginHex}:compression:state:${sessionID}`
    const at = Date.now()
    conn
      .query("insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)")
      .run(key, JSON.stringify(state), at, at)
    conn.close()
  }

  /** 输入：sessionID；输出：messages 数组。 */
  const messagesFor = async (sessionID) =>
    api("GET", `/api/session/${sessionID}/message?limit=200`)

  /**
   * 输入：sessionID + 判定函数 + 标签。
   * 输出：满足判定时的插件 state。
   * 预期：每 100ms 重读一次 state，最多等 30s；超时抛出带最后状态的错误，不静默通过。
   */
  const waitForState = async (sessionID, predicate, label) => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const state = stateFor(sessionID)
      if (predicate(state)) return state
      if (Date.now() > deadline) {
        const snapshot = {
          phase: state?.phase,
          blocks: state?.blocks?.map((block) => `${block.id}:T${block.tier}`),
          pending: state?.pending?.id,
          attempts: state?.attempts,
          lastError: state?.lastError,
        }
        throw new Error(`timed out waiting for ${label}: ${JSON.stringify(snapshot)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** 输入：sessionID + 判定函数 + 标签；输出：满足判定时的缓存历史；超时抛错。 */
  const waitForCacheHistory = async (sessionID, predicate, label) => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const history = cacheHistoryFor(sessionID)
      if (predicate(history)) return history
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}: ${JSON.stringify(history)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  const session = await api("POST", "/api/session", {
    title: "e2e",
    model: { providerID: "fake", id: "small" },
  })
  const sessionID = session.id ?? session.sessionID
  assert.ok(sessionID, "session id missing")
  console.log("session:", sessionID)

  // 小窗口模型（50k 覆盖）下，60% 阈值 = 30k token。假 provider 必须报真实 usage：
  // 没有 usage 时插件回退 estimateTotal，而 compact 后历史被替换、估算骤降，
  // 永远到不了阈值，第二个 T1 压不出来，合并也就永远没有候选。
  usagePromptTokens = 40_000
  await setSettings(10, 50_000, 60)
  for (let index = 0; index < 8; index += 1) {
    const state = stateFor(sessionID)
    if ((state?.blocks ?? []).some((block) => block.tier === 2)) break
    await promptSession(sessionID, index < 4 ? longText : "continue")
  }
  // phase 排好后需要新请求驱动合并：轮询不产生请求，持续发短消息直到 T2 出现。
  for (let index = 0; index < 10; index += 1) {
    if ((stateFor(sessionID)?.blocks ?? []).some((block) => block.tier === 2)) break
    await promptSession(sessionID, "continue")
  }
  await waitForState(
    sessionID,
    (state) => (state?.blocks ?? []).some((block) => block.tier === 2),
    "T2 merge",
  )
  await waitForState(
    sessionID,
    (state) => (state?.blocks ?? []).some((block) => block.tier === 2),
    "T2 merge",
  )

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
  assert.ok(
    String(latest?.summary ?? "").includes("[T2] {h2} · merged #b1 + #b2"),
    "T2 header must show merged sources",
  )
  assert.ok(raw.includes("[T1]"), "block header must show tier")
  assert.ok(raw.includes("{h1}"), "block header must show tree height")
  console.log("T1 and T2 checkpoints found")

  assert.ok(
    !prompts.some((prompt) => prompt.includes("You MUST use this format")),
    "native summary prompt must not run",
  )
  assert.ok(
    compactions.some((item) => String(item.summary ?? "").includes("verify isolated T1 compaction")),
    "T1 summary content must be visible",
  )
  assert.ok(
    compactions.some((item) => String(item.summary ?? "").includes("verify isolated T2 merge")),
    "T2 summary content must be visible",
  )
  console.log("case passed: hook summary replaces native and is visible")

  // case: 有消息时手动 compact，检查插件钩子是否报错/是否又跑原生摘要
  mode = "normal"
  await setSettings(50, 1_000_000, 95)
  const manual = await newSession("e2e-manual-compact")
  await promptSession(manual, longText)
  await promptSession(manual, "continue")
  await api("POST", `/api/session/${manual}/compact`, {})
  await waitSession(manual)
  const manualMessages = await messagesFor(manual)
  const manualCompaction = [...manualMessages].reverse().find((item) => item.type === "compaction")
  console.log(
    "manual compaction:",
    JSON.stringify(manualCompaction?.error ?? manualCompaction?.status ?? "missing"),
  )
  console.log("manual state:", JSON.stringify(stateFor(manual)))
  console.log(
    "manual prompts:",
    JSON.stringify(
      prompts.slice(-5).map((prompt) => prompt.slice(0, 100).replace(/\s+/g, " ")),
    ),
  )

  // case: 块头显示 token 估算与时间线（默认关闭，这里显式打开）
  mode = "normal"
  await setSettings(50, 1_000_000, 95, { showBlockTokens: true, showTimeline: true })
  const meta = await newSession("e2e-block-meta")
  await promptSession(meta, longText)
  await promptSession(meta, "continue")
  await api("POST", `/api/session/${meta}/compact`, {})
  await waitSession(meta)
  const metaMessages = await messagesFor(meta)
  const metaCompaction = [...metaMessages]
    .reverse()
    .find((item) => item.type === "compaction" && item.status === "completed")
  const metaSummary = String(metaCompaction?.summary ?? "")
  assert.ok(metaSummary.includes("≈"), "block header must show token estimate")
  assert.ok(metaSummary.includes("tok"), "block header must show tok unit")
  assert.ok(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(metaSummary), "block header must show timeline")
  console.log("case passed: block header shows token estimate and timeline")

  // case: 手动 compact 空历史 → failed，state 不产生块
  mode = "short"
  await setSettings(50)
  const empty = await newSession("e2e-empty")
  await api("POST", `/api/session/${empty}/compact`, {})
  await promptSession(empty, "continue")
  const emptyMessages = await messagesFor(empty)
  const emptyCompaction = emptyMessages.find((item) => item.type === "compaction")
  assert.equal(emptyCompaction?.status, "failed", "empty compact should fail")
  assert.equal(stateFor(empty)?.blocks?.length ?? 0, 0, "empty compact must not create a block")
  console.log("case passed: empty compact fails cleanly")

  // case: T1 摘要非法 → compaction failed，state 不产生块
  mode = "invalid-t1"
  // 强制真实 usage 超阈值，专门测摘要校验失败，不依赖文本估算大小。
  usagePromptTokens = 90_000
  await setSettings(50)
  const invalid = await newSession("e2e-invalid-t1")
  await promptSession(invalid, longText)
  await promptSession(invalid, "continue")
  const invalidMessages = await messagesFor(invalid)
  assert.equal(
    invalidMessages.find((item) => item.type === "compaction")?.status,
    "failed",
    "invalid T1 should fail",
  )
  assert.equal(stateFor(invalid)?.blocks?.length ?? 0, 0, "invalid T1 must not create a block")
  const invalidState = stateFor(invalid)
  assert.equal(invalidState?.pending, undefined, "failed T1 must not leave pending")
  assert.equal(invalidState?.phase, undefined, "failed T1 must not leave phase")
  // 默认 summaryFormat=markdown，短回复会先被长度校验拒绝，不一定是 JSON 解析错误。
  assert.match(String(invalidState?.lastError ?? ""), /not valid JSON|summary too short/)
  usagePromptTokens = undefined
  console.log("case passed: invalid T1 fails cleanly")

  // case: T1 结构非法（goal 为空）→ failed，state 不残留
  mode = "bad-shape-t1"
  usagePromptTokens = 90_000
  await setSettings(50)
  const badShape = await newSession("e2e-bad-shape-t1")
  await promptSession(badShape, longText)
  await promptSession(badShape, "continue")
  const badShapeMessages = await messagesFor(badShape)
  assert.equal(
    badShapeMessages.find((item) => item.type === "compaction")?.status,
    "failed",
    "bad shape T1 should fail",
  )
  const badShapeState = stateFor(badShape)
  assert.equal(badShapeState?.blocks?.length ?? 0, 0)
  assert.equal(badShapeState?.pending, undefined)
  assert.equal(badShapeState?.phase, undefined)
  assert.match(String(badShapeState?.lastError ?? ""), /empty field: goal/)
  usagePromptTokens = undefined
  console.log("case passed: bad-shape T1 fails without residue")

  // case: 第一次 T1 摘要失败，OpenCode 重试后成功
  mode = "retry-t1"
  t1Attempts = 0
  usagePromptTokens = 90_000
  await setSettings(50)
  const retry = await newSession("e2e-retry-t1")
  await promptSession(retry, longText)
  await promptSession(retry, "continue")
  let retryState = stateFor(retry)
  for (let index = 0; index < 40 && (retryState?.blocks?.length ?? 0) === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    retryState = stateFor(retry)
  }
  assert.equal(retryState?.blocks?.length, 1, "T1 retry should create a block")
  usagePromptTokens = undefined
  console.log("case passed: T1 retry succeeds")

  // case: T2 第一次摘要非法，OpenCode 重试后成功
  mode = "retry-t2"
  t2Attempts = 0
  usagePromptTokens = 90_000
  await setSettings(2.5)
  const t2Retry = await newSession("e2e-retry-t2", undefined, "small")
  for (let index = 0; index < 10; index += 1) {
    if ((stateFor(t2Retry)?.blocks ?? []).some((item) => item.tier === 2)) break
    await promptSession(t2Retry, index < 5 ? longText : "continue")
  }
  let t2RetryState = stateFor(t2Retry)
  // 纯轮询不产生请求：phase 排好后要靠新请求驱动合并，持续发短消息直到 T2 出现。
  for (let index = 0; index < 10 && !(t2RetryState?.blocks ?? []).some((item) => item.tier === 2); index += 1) {
    await promptSession(t2Retry, "continue")
    t2RetryState = stateFor(t2Retry)
  }
  assert.ok(
    (t2RetryState?.blocks ?? []).some((item) => item.tier === 2),
    "T2 retry should create a tier-2 block",
  )
  usagePromptTokens = undefined
  console.log("case passed: T2 retry succeeds")

  // case: compress 工具在真实 OpenCode 里执行并生成 T1
  mode = "tool-compress"
  toolPromptCount = 0
  await setSettings(50, 1_000_000, 95)
  const toolSession = await newSession("e2e-tool-compress")
  await promptSession(toolSession, longText)
  await promptSession(toolSession, "use compress tool")
  await promptSession(toolSession, "continue")
  let toolState = stateFor(toolSession)
  for (let index = 0; index < 40 && (toolState?.blocks?.length ?? 0) === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    toolState = stateFor(toolSession)
  }
  const toolMessages = await messagesFor(toolSession)
  const toolParts = toolMessages.flatMap((message) =>
    (message.parts ?? message.content ?? [])
      .filter((part) => part.type === "tool" || part.type === "tool-call" || part.type === "tool-result")
      .map((part) => ({
        type: part.type,
        tool: part.tool,
        status: part.state?.status,
        error: part.state?.error,
        output: part.state?.output,
        content: part.state?.content,
      })),
  )
  console.log("tool parts:", JSON.stringify(toolParts))
  const lastAssistant = [...toolMessages].reverse().find((message) => message.type === "assistant")
  console.log("tool assistant keys:", JSON.stringify(Object.keys(lastAssistant ?? {})))
  console.log(
    "tool assistant content:",
    JSON.stringify(lastAssistant?.content ?? lastAssistant?.parts).slice(0, 600),
  )
  assert.ok(
    (toolState?.blocks ?? []).some((item) => item.summary.title === "Tool T1"),
    "compress tool should create a Tool T1 block",
  )
  console.log("case passed: compress tool creates T1")

  // case: decompress 工具取回已压缩块的原文
  // 走 compress 工具排队 T1（contextLimit=1M 永远到不了自动触发的百分比线）
  mode = "tool-decompress"
  toolPromptCount = 0
  decompressTriggered = false
  await setSettings(50, 1_000_000, 95)
  const decompressSession = await newSession("e2e-tool-decompress")
  await promptSession(decompressSession, longText)
  await promptSession(decompressSession, "use compress tool")
  await promptSession(decompressSession, "continue")
  // 等 T1 完成，拿到块
  let decompressState = stateFor(decompressSession)
  for (let index = 0; index < 40 && (decompressState?.blocks?.length ?? 0) === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    decompressState = stateFor(decompressSession)
  }
  assert.ok((decompressState?.blocks?.length ?? 0) > 0, "decompress case needs a compressed block")
  const decompressBlock = decompressState?.blocks?.[0]
  assert.ok(decompressBlock, "decompress case needs a block")
  // 让模型调用 decompress 取回原文
  await promptSession(decompressSession, "use decompress tool")
  await waitSession(decompressSession)
  const decompressMessages = await messagesFor(decompressSession)
  const decompressParts = decompressMessages.flatMap((message) =>
    (message.parts ?? message.content ?? [])
      .filter((part) => part.type === "tool")
      .map((part) => ({
        name: part.name,
        status: part.state?.status,
        error: part.state?.error,
        content: JSON.stringify(part.state?.content ?? "").slice(0, 400),
      })),
  )
  console.log("decompress parts:", JSON.stringify(decompressParts))
  const decompressCall = decompressParts.find((part) => part.name === "decompress")
  assert.ok(decompressCall, "model should call decompress tool")
  assert.equal(decompressCall.status, "completed", "decompress tool should complete")
  assert.ok(
    !(decompressCall.content ?? "").includes("unavailable"),
    "decompress should restore original transcript from the DB",
  )
  assert.ok((decompressCall.content ?? "").includes("≈"), "decompress result must show token estimate")
  assert.ok((decompressCall.content ?? "").includes("tok"), "decompress result must show tok unit")
  console.log("case passed: decompress tool restores content")

  // case: 超大摘要上限被运行时钳制，压缩仍成功
  mode = "normal"
  // 用真实 usage 超阈值，不依赖文本估算（短文本本身到不了大窗口的触发线）。
  usagePromptTokens = 90_000
  await setSettings(90, 100_000, 80, { summaryBlockPercent: 90 })
  const clamp = await newSession("e2e-clamp")
  await promptSession(clamp, longText)
  await promptSession(clamp, "continue")
  const clampMessages = await messagesFor(clamp)
  const clampCompactions = clampMessages.filter((item) => item.type === "compaction" && item.status === "completed")
  assert.ok(clampCompactions.length > 0, "clamped session should still compress")
  const clampState = stateFor(clamp)
  assert.ok((clampState?.blocks?.length ?? 0) > 0, "clamped session should have a block")
  usagePromptTokens = undefined
  console.log("case passed: oversized limits clamped, compression still works")

  // case: 父子/不同 session 状态隔离（先恢复 autoCompress，上一 case 关了它）
  mode = "normal"
  usagePromptTokens = 90_000
  await setSettings(50, 100_000, 80)
  const sessionA = await newSession("e2e-iso-a")
  const sessionB = await newSession("e2e-iso-b")
  for (const id of [sessionA, sessionB]) {
    await promptSession(id, "parent-tools-marker")
    await promptSession(id, longText)
    await promptSession(id, "continue")
  }
  const stateA = assertBlockCount(sessionA, 1, "session A should have one block")
  const stateB = assertBlockCount(sessionB, 1, "session B should have one block")
  assert.equal(stateA?.blocks?.[0]?.tier, 1)
  assert.equal(stateB?.blocks?.[0]?.tier, 1)
  assert.notEqual(stateA?.blocks?.[0]?.fromId, stateB?.blocks?.[0]?.fromId)
  usagePromptTokens = undefined
  console.log("case passed: auto T1 triggered by context hook, no manual compact")

  // case: 真实 usage 达到阈值时触发，不依赖文本估算
  mode = "normal"
  usagePromptTokens = 90_000
  await setSettings(50, 100_000, 80)
  const usageSession = await newSession("e2e-real-usage")
  await promptSession(usageSession, "x".repeat(6_000))
  const usageMessages = await messagesFor(usageSession)
  console.log(
    "usage messages",
    usageMessages
      .filter((item) => item.type === "assistant")
      .slice(-2)
      .map((item) => item.tokens),
  )
  await promptSession(usageSession, "continue")
  const usageState = await waitForState(
    usageSession,
    (state) => (state?.blocks?.length ?? 0) > 0,
    "real usage trigger",
  )
  assert.equal(usageState.blocks[0]?.tier, 1, "real usage should trigger T1")
  console.log("case passed: real usage triggers auto compression")
  usagePromptTokens = undefined

  // case: autoCompress 关闭时只保留手动压缩
  mode = "normal"
  await setSettings(50, 50_000, 60, { autoCompress: false })
  const noAuto = await newSession("e2e-no-auto")
  await promptSession(noAuto, longText)
  await promptSession(noAuto, "continue")
  assert.equal(stateFor(noAuto)?.blocks?.length ?? 0, 0, "autoCompress off must not compress")
  await api("POST", `/api/session/${noAuto}/compact`, {})
  await waitSession(noAuto)
  await waitForState(noAuto, (state) => (state?.blocks?.length ?? 0) >= 1, "manual compact creates a block")
  console.log("case passed: autoCompress off keeps manual compaction")

  // case: 摘要压完就超预算时下一次请求自己接合并，不等用量过线
  mode = "normal"
  usagePromptTokens = 50_000
  // 窗口 100k、阈值 95% = 95k + 关提醒 + 先用 autoCompress:false 建块：
  // 建块阶段不让阈值路径/新闸门插手，保证正好两个 T1、phase 为空。
  await setSettings(50, 100_000, 95, { nudgeGrowthTokens: 0, autoCompress: false })
  const overBudget = await newSession("e2e-over-budget")
  for (let round = 0; round < 2; round += 1) {
    await promptSession(overBudget, longText)
    await promptSession(overBudget, "continue")
    await api("POST", `/api/session/${overBudget}/compact`, {})
    await waitSession(overBudget)
    await waitForState(
      overBudget,
      (state) => (state?.blocks?.length ?? 0) >= round + 1,
      "over-budget T1 $" + (round + 1).toString(),
    )
  }
  const wideBudget = await waitForState(
    overBudget,
    (state) => (state?.blocks?.length ?? 0) >= 2,
    "over-budget needs two blocks",
  )
  // 宽预算（50%）下 T1 收尾不会排下一层：phase 为空，正是线上卡住的形状。
  assert.equal(wideBudget.phase, undefined, "wide budget must not schedule a merge")
  // 事后把全部摘要预算收紧到 1%（保留区用默认 2）：摘要已经超了，但 phase 还是空的。
  await setSettings(1, 100_000, 95, { nudgeGrowthTokens: 0 })
  // 用量 50k 远低于阈值 95k：接下来只要有压缩发生，就只可能是「摘要超预算」这条新闸门。
  const beforeMerging = stateFor(overBudget)?.blocks?.length ?? 0
  await promptSession(overBudget, "continue again")
  // 第一刀可能仍在收旧原文（T1 优先），继续聊几轮让链自己接上；全程用量不过阈值。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = stateFor(overBudget)
    if ((current?.blocks?.length ?? 0) > beforeMerging) break
    await promptSession(overBudget, "continue")
    await waitSession(overBudget)
  }
  const mergedState = await waitForStateEvent(
    overBudget,
    (state) =>
      (state?.blocks?.length ?? 0) > beforeMerging ||
      (state?.blocks ?? []).some((block) => block.tier >= 2),
    "over-budget auto compaction",
  )
  assert.ok(
    (mergedState.blocks?.length ?? 0) > beforeMerging ||
      (mergedState.blocks ?? []).some((block) => block.tier >= 2),
    "summary over budget must trigger compaction without crossing the usage threshold",
  )
  console.log("case passed: summary over budget triggers compaction")
  usagePromptTokens = undefined

  // case: 父子/子代理状态隔离（显式恢复设置：上一 case 关了 autoCompress）
  mode = "normal"
  usagePromptTokens = 90_000
  await setSettings(50, 100_000, 80)
  const child = await newSession("e2e-iso-child", sessionA)
  await promptSession(child, `iso-child-marker ${longText}`)
  await promptSession(child, "continue")
  // 子代理会话必须正常自动压缩：块归子代理自己，父会话不得多块。
  // 失败时把 child 的 assistant tokens 倾倒出来定位触发链断在哪。
  let stateChild
  try {
    stateChild = await waitForStateEvent(
      child,
      (state) => (state?.blocks?.length ?? 0) > 0,
      "child block",
    )
  } catch (error) {
    const msgs = await messagesFor(child)
    console.error(
      "child assistant tokens:",
      JSON.stringify(
        msgs
          .filter((item) => item.type === "assistant")
          .map((item) => ({ model: item.model, tokens: item.tokens })),
      ),
    )
    const childSession = await api("GET", `/api/session/${child}`).catch(() => undefined)
    console.error("child session agent/model:", JSON.stringify({ agent: childSession?.agent, model: childSession?.model }))
    // 倾倒 child 视角的服务端设置与生效窗口：定位 maybeAutoCompress 断在哪个分支。
    const settingsNow = await api("POST", "/api/rpc/compressed-context/settingsGet", {
      input: { sessionID: child },
    }).catch((e) => ({ rpcError: String(e) }))
    console.error("child settings:", JSON.stringify(settingsNow).slice(0, 400))
    const hex = Array.from("compressed-context").map((c) => c.codePointAt(0).toString(16).padStart(4, "0")).join("")
    const db2 = new Database(join(root, "opencode.db"))
    const win = db2
      .query("select key, value from kv where key like ?")
      .all(`plugin:${hex}:window:effective:${child}`)
    console.error("child effective window rows:", JSON.stringify(win))
    db2.close()
    throw error
  }
  const stateAAfterChild = stateFor(sessionA)
  assert.equal(stateChild.blocks.length, 1, "child should have its own block")
  assert.equal(stateAAfterChild?.blocks?.length, 1, "parent must not gain child blocks")
  assert.equal(stateChild.blocks[0]?.sourceBlockIds, undefined)
  usagePromptTokens = undefined

  // 子代理上下文里不出现 compress / decompress / checkpoint_tree：
  // 子代理 prompt 带唯一标记，假 provider 记录每次请求的工具名，按标记查询。
  const childToolNames = capturedToolNames("iso-child-marker")
  assert.ok(childToolNames.length > 0, "subagent request must have been captured")
  if (
    childToolNames.includes("compress") ||
    childToolNames.includes("decompress") ||
    childToolNames.includes("checkpoint_tree")
  ) {
    const allChild = capturedRequests.filter((request) => request.text.includes("iso-child-marker"))
    console.error(
      "child requests (session ids + kinds):",
      JSON.stringify(
        allChild.map((request) => ({ session: request.session, kind: request.kind, names: request.names.slice(0, 6) })),
      ),
    )
  }
  assert.equal(
    childToolNames.includes("compress") ||
      childToolNames.includes("decompress") ||
      childToolNames.includes("checkpoint_tree"),
    false,
    "subagent requests must not carry compression tools",
  )
  // 父会话请求仍然带全三个工具。
  const parentToolNames = capturedToolNames("parent-tools-marker")
  assert.ok(parentToolNames.includes("compress"), "parent requests must carry compress")
  assert.ok(parentToolNames.includes("decompress"), "parent requests must carry decompress")
  assert.ok(parentToolNames.includes("checkpoint_tree"), "parent requests must carry checkpoint_tree")
  console.log("case passed: parent/child compression history isolated")

  // case: T2→T3 链（预算驱动的多轮蒸馏）
  // 前三轮高预算只产 T1；降预算后第 4 个 T1 挂 phase=t2。
  // 下一次模型请求由 context 钩子入队 compaction，钩子在 older 只有 checkpoint 时合并一对：
  /**
   * 输入：插件 state。
   * 输出：active 顶层块，按 order 排序。
   * 预期：被任何块 sourceBlockIds 引用过的块不算 active。
   */
  const activeBlocksOf = (state) => {
    const consumed = new Set((state?.blocks ?? []).flatMap((block) => block.sourceBlockIds ?? []))
    return (state?.blocks ?? [])
      .filter((block) => !consumed.has(block.id))
      .sort((left, right) => left.order - right.order)
  }

  // 合并机制：低预算挂合并标记 → 按摘要占用选层 → 模型选前 1..N 个同层块 → 封顶 T3。
  // 先高预算攒够 T1，再降预算触发合并，只断言不变量与终局，不锁死中间块编号。
  mode = "merge-all"
  await setSettings(50, 1_000_000, 95, { summaryBlockPercent: 20, recentT1Blocks: 0 })
  const chainSession = await newSession("e2e-merge-chain")
  for (let round = 0; round < 4; round += 1) {
    await promptSession(chainSession, longText)
    await promptSession(chainSession, "continue")
    await api("POST", `/api/session/${chainSession}/compact`, {})
    await waitSession(chainSession)
    await waitForState(chainSession, (state) => (state?.blocks?.length ?? 0) >= round + 1, "chainSession T1 $" + (round + 1).toString())
  }
  let chainState = assertBlockCount(chainSession, 4, "chain case needs four T1 blocks first")
  assert.equal(
    (chainState?.blocks ?? []).every((block) => block.tier === 1 && block.height === 1),
    true,
    "T1 blocks must be tier 1 with height 1",
  )
  assert.equal(chainState?.phase, undefined, "high budget must not schedule a merge")

  // 降预算后下一轮 T1 完成时挂合并标记；标记只是数字 2，不再编码目标层。
  // 窗口收到 200k：1% = 2k 预算，五块 1.7k 字符的摘要必然超预算（auto 与 compaction 两条路径口径一致）。
  await setSettings(1, 200_000, 95, { summaryBlockPercent: 20, recentT1Blocks: 0 })
  await promptSession(chainSession, longText)
  await promptSession(chainSession, "continue")
  await api("POST", `/api/session/${chainSession}/compact`, {})
  await waitSession(chainSession)
  // 压缩钩子先把新块写成 pending，等事件提交后才进 blocks；这里等提交落地，不等固定时间。
  chainState = await waitForState(
    chainSession,
    (state) => (state?.blocks?.length ?? 0) >= 5 && state?.pending === undefined,
    "low-budget round commits a new block",
  )
  assert.ok(
    (chainState?.blocks?.length ?? 0) >= 5,
    `low-budget round adds at least one T1 block — actual ${JSON.stringify({
      blocks: (chainState?.blocks ?? []).map((block) => `${block.id}:T${block.tier}:{h${block.height}}`),
      phase: chainState?.phase,
      pending: chainState?.pending?.id,
      distillRounds: chainState?.distillRounds,
      lastError: chainState?.lastError,
    })}`,
  )
  assert.ok((chainState?.phase === 2) || (chainState?.blocks ?? []).some((block) => block.tier >= 2), "low budget must arm merging")
  console.log("case passed: low budget schedules merge phase after T1")

  // 一刀合并：产物封顶 3、height 递增、active 链 tier 单调不增。
  await promptSession(chainSession, "continue")
  chainState = await waitForState(
    chainSession,
    (state) => (state?.blocks ?? []).some((block) => block.tier === 2 && block.height === 2),
    "first merge produces a T2 block with height 2",
  )
  const firstT2 = chainState.blocks.find((block) => block.tier === 2)
  assert.ok((firstT2?.sourceBlockIds?.length ?? 0) >= 2, "model merged a two-block prefix")
  assert.ok(
    (chainState.blocks ?? []).every((block) => block.tier <= 3),
    "no block may exceed the tier cap",
  )
  const activeAfterMerge = activeBlocksOf(chainState)
  for (let index = 1; index < activeAfterMerge.length; index += 1) {
    assert.ok(
      activeAfterMerge[index].tier <= activeAfterMerge[index - 1].tier,
      "active chain tier must be non-increasing",
    )
  }
  console.log("case passed: merge takes a same-tier prefix and keeps tiers monotonic")

  // 一直推到预算内：终局是单个块，层数不超过 3，深度反映折叠次数。
  for (let round = 0; round < 10; round += 1) {
    if (stateFor(chainSession)?.phase === undefined) break
    await promptSession(chainSession, "continue")
    await waitSession(chainSession)
  }
  chainState = stateFor(chainSession)
  const finalActive = activeBlocksOf(chainState)
  assert.equal(chainState?.phase, undefined, "chain must end under budget with no merge marker")
  assert.ok(finalActive.length >= 1 && finalActive.length <= 3, "active chain must stay small")
  assert.ok((finalActive[0]?.tier ?? 99) <= 3, "final tier must be capped at 3")
  assert.ok((finalActive[0]?.height ?? 0) > 1, "final height must reflect the foldings")
  assert.equal(chainState?.attempts, 0, "no failed attempts may linger")
  assert.equal(chainState?.lastError, undefined, "no compression error may linger")
  console.log("case passed: chain converges to one capped block with growing height")

  // case: 编辑保留区设置——RPC 落盘（TUI 走的就是这条）→ 读回确认没被 schema 剥掉 → 下一刀按新值保留。
  mode = "merge-all"
  await setSettings(50, 1_000_000, 95, { summaryBlockPercent: 20, recentT1Blocks: 0 })
  const editSession = await newSession("e2e-edit-retention")
  for (let round = 0; round < 5; round += 1) {
    await promptSession(editSession, longText)
    await promptSession(editSession, "continue")
    await api("POST", `/api/session/${editSession}/compact`, {})
    await waitSession(editSession)
    await waitForState(editSession, (state) => (state?.blocks?.length ?? 0) >= round + 1, "editSession T1 $" + (round + 1).toString())
  }
  let editState = stateFor(editSession)
  assert.equal(editState?.blocks?.length, 5, "edit case needs five T1 blocks")
  assert.equal(editState?.phase, undefined, "high budget must not schedule a merge")

  await api("POST", "/api/rpc/compressed-context/settingsSet", {
    input: {
      // 窗口收到 200k：1% 的摘要预算 = 2k，五个 1.7k 字符的块已经超预算。
      contextLimit: 200_000,
      triggerPercent: 95,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      recentT1Blocks: 3,
    },
  })
  await Bun.sleep(1_100)
  const editedSettings = JSON.parse(await readFile(settingsPath, "utf8"))
  assert.equal(editedSettings.recentT1Blocks, 3, "settingsSet must persist recentT1Blocks")

  // 预算一收紧，一条短消息就能触发合并：压缩时 older 只剩 checkpoint，走合并分支。
  // 不再补造第 6 个 T1——那会把保留区挤掉一块，测的就不是「保留区生效」了。
  await promptSession(editSession, "continue")
  editState = await waitForState(
    editSession,
    (state) => (state?.blocks ?? []).some((block) => block.tier === 2),
    "merge after editing retention",
  )
  const editT2 = editState.blocks.find((block) => block.tier === 2)
  assert.ok((editT2?.sourceBlockIds?.length ?? 0) >= 2, "only the oldest eligible T1 blocks may merge")
  const editConsumed = new Set(editState.blocks.flatMap((block) => block.sourceBlockIds ?? []))
  const editActive = editState.blocks.filter((block) => !editConsumed.has(block.id))
  assert.equal(
    editActive.filter((block) => block.tier === 1).length,
    3,
    "the newest three T1 blocks must stay untouched",
  )
  console.log("case passed: editing recentT1Blocks changes merge behavior")

  // case: Babel 也要走同一条合并链——保持 format=babel、c=N 选前缀、层数封顶 3。
  mode = "merge-all"
  await setSettings(50, 1_000_000, 95, {
    summaryBlockPercent: 20,
    summaryFormat: "babel",
    recentT1Blocks: 0,
  })
  const babelSession = await newSession("e2e-babel-t3", undefined, "fake")
  for (let round = 0; round < 4; round += 1) {
    await promptSession(babelSession, longText)
    await promptSession(babelSession, "continue")
    await api("POST", `/api/session/${babelSession}/compact`, {})
    await waitSession(babelSession)
    await waitForState(babelSession, (state) => (state?.blocks?.length ?? 0) >= round + 1, "babelSession T1 $" + (round + 1).toString())
  }
  let babelState = stateFor(babelSession)
  const babelBaseBlocks = babelState?.blocks?.length ?? 0
  assert.ok(babelBaseBlocks >= 4, "Babel case needs at least four T1 blocks")
  assert.equal(
    (babelState?.blocks ?? []).every((block) => block.tier === 1 && block.summary?.format === "babel"),
    true,
    "all Babel T1 blocks must be tier 1 and format=babel",
  )
  assert.equal(babelState?.phase, undefined, "Babel high budget must not schedule a merge")

  await setSettings(1, 50_000, 95, {
    summaryBlockPercent: 20,
    summaryFormat: "babel",
    recentT1Blocks: 0,
    models: { "fake/fake": { contextLimit: 50_000 } },
  })
  await promptSession(babelSession, longText)
  await promptSession(babelSession, "continue")
  // 预算收紧后自动压缩自己就在请求里接上了；再手动补一刀只会撞上「没有可压缩内容」。
  await waitSession(babelSession)
  // 同上：等新块真正提交进 blocks，而不是等 pending 那一刻的快照。
  babelState = await waitForState(
    babelSession,
    (state) => (state?.blocks?.length ?? 0) >= babelBaseBlocks + 1 && state?.pending === undefined,
    "Babel low-budget round commits a new block",
  )
  assert.ok(
    (babelState?.blocks?.length ?? 0) >= babelBaseBlocks + 1,
    `Babel low-budget round adds at least one T1 block — actual ${JSON.stringify({
      blocks: (babelState?.blocks ?? []).map((block) => `${block.id}:T${block.tier}:{h${block.height}}`),
      phase: babelState?.phase,
      pending: babelState?.pending?.id,
      distillRounds: babelState?.distillRounds,
      lastError: babelState?.lastError,
    })}`,
  )
  assert.ok((babelState?.phase === 2) || (babelState?.blocks ?? []).some((block) => block.tier >= 2), `Babel low budget must arm merging: ${JSON.stringify({ phase: babelState?.phase, blocks: (babelState?.blocks ?? []).map((block) => `${block.id}:T${block.tier}`), rounds: babelState?.distillRounds })}`)

  await promptSession(babelSession, "continue")
  babelState = await waitForState(
    babelSession,
    (state) => (state?.blocks ?? []).some((block) => block.tier === 2),
    "Babel T2 merge",
  )
  const babelT2 = (babelState?.blocks ?? []).find((block) => block.tier === 2)
  assert.equal(babelT2?.summary?.format, "babel", "Babel T2 must keep format=babel")
  assert.ok((babelT2?.sourceBlockIds?.length ?? 0) >= 2, "Babel T2 merges a two-block prefix")

  for (let round = 0; round < 10; round += 1) {
    if (stateFor(babelSession)?.phase === undefined) break
    await promptSession(babelSession, "continue")
    await waitSession(babelSession)
  }
  babelState = stateFor(babelSession)
  const babelActive = activeBlocksOf(babelState)
  assert.ok(babelActive.length >= 1 && babelActive.length <= 3, "Babel active chain must stay small")
  assert.ok((babelActive[0]?.tier ?? 99) <= 3, "Babel active chain must end at or below T3")
  assert.equal(babelState?.lastError, undefined, `Babel chain must not leave lastError: ${String(babelState?.lastError).slice(0, 300)}`)
  console.log("case passed: Babel T1→T2→T3 with capped tiers")

  // case: 走真实 RPC 切换摘要格式后，compress 工具的描述与参数跟着换。
  await api("POST", "/api/rpc/compressed-context/settingsSet", {
    input: { contextLimit: 1_000_000, triggerPercent: 95, summaryFormat: "babel" },
  })
  lastCompressTool = undefined
  const formatSession = await newSession("e2e-format-tool")
  await promptSession(formatSession, "format switch")
  assert.ok(lastCompressTool, "request must carry the compress tool")
  assert.equal(
    lastCompressTool.description.includes("Return ONLY Babel text"),
    true,
    "compress description must switch to Babel after settingsSet",
  )
  const formatFields = Object.keys(lastCompressTool.parameters?.properties ?? {}).sort()
  assert.deepEqual(formatFields, ["babel", "title"], "compress parameters must only expose Babel fields")
  console.log("case passed: summary format switches compress tool shape")

  // case: 长会话压测（大窗口 + 多轮，模拟真实尺寸）
  // 每轮：长消息 + continue → 手动 compact 产 T1 → 再发一条触发下一次模型请求；
  // 若 T1 后超预算，context 钩子入队合并。验证多轮后链收敛、tier 单调、无残留错误。
  mode = "long-session"
  await setSettings(2, 200_000, 80, { recentT1Blocks: 0 })
  const longSession = await newSession("e2e-long-session", undefined, "fake")
  const longTurns = 6
  for (let turn = 0; turn < longTurns; turn += 1) {
    await promptSession(longSession, longText)
    await promptSession(longSession, longText)
    await promptSession(longSession, "continue")
    await api("POST", `/api/session/${longSession}/compact`, {})
    await waitSession(longSession)
    await promptSession(longSession, "continue")
  }
  const longState = stateFor(longSession)
  const longBlocks = longState?.blocks ?? []
  const longMerged = longBlocks.filter((block) => (block.sourceBlockIds ?? []).length > 0)
  const longConsumed = new Set(longBlocks.flatMap((block) => block.sourceBlockIds ?? []))
  const longActive = longBlocks
    .filter((block) => !longConsumed.has(block.id))
    .sort((left, right) => left.order - right.order)
  console.log(
    "long session blocks:",
    longBlocks.map((block) => `${block.id}:T${block.tier}:${(block.sourceBlockIds ?? []).join("+")}`).join(" "),
    "active:",
    longActive.map((block) => `${block.id}:T${block.tier}`).join(" "),
    "phase:",
    longState?.phase,
  )
  assert.ok(longBlocks.length >= longTurns, "each turn must add at least one block")
  assert.ok(longMerged.length >= 1, "long session must merge more than once")
  assert.ok(longActive.length <= 3, "merged chain must collapse to a single active block")
  assert.ok((longActive[0]?.tier ?? 99) <= 3, "repeated merges must stay capped at T3")
  assert.ok((longActive[0]?.height ?? 0) > 1, "height must reflect repeated foldings")
  assert.equal(longState?.phase, undefined, "chain must be under budget after the last merge")
  assert.equal(longState?.attempts, 0, "no failed attempts may linger")
  assert.equal(longState?.lastError, undefined, "no compression error may linger")
  console.log("case passed: long session converges to one capped block")

  // case: 缓存命中历史按会话持久化，最多 10 条
  const mainHistory = await waitForCacheHistory(
    sessionID,
    (history) => (history?.samples?.length ?? 0) > 0,
    "main cache history",
  )
  assert.ok(mainHistory.samples.length <= 10, "cache history must keep at most 10 samples")
  for (const sample of mainHistory.samples) {
    assert.equal(typeof sample.messageID, "string", "sample messageID must be a string")
    assert.ok(sample.at >= 0, "sample time must be non-negative")
    assert.ok(sample.input >= sample.cached, "input must include cached tokens")
    assert.equal(
      sample.hitRate,
      sample.input > 0 ? Math.round((sample.cached / sample.input) * 100) : 0,
      "hit rate must match cached / input",
    )
    assert.ok(sample.hitRate >= 0 && sample.hitRate <= 100, "hit rate must be 0..100")
  }
  for (let index = 1; index < mainHistory.samples.length; index += 1) {
    assert.ok(
      mainHistory.samples[index].at >= mainHistory.samples[index - 1].at,
      "cache history must be sorted by time",
    )
  }
  console.log("case passed: cache history persisted per session")

  // case: 两个会话的缓存历史互不串
  const otherCacheSession = await newSession("cache-history-other")
  await promptSession(otherCacheSession, "other session cache history")
  const otherHistory = await waitForCacheHistory(
    otherCacheSession,
    (history) => (history?.samples?.length ?? 0) > 0,
    "other cache history",
  )
  const mainIDs = new Set(mainHistory.samples.map((sample) => sample.messageID))
  assert.ok(
    otherHistory.samples.every((sample) => !mainIDs.has(sample.messageID)),
    "cache histories must not share message ids",
  )
  console.log("case passed: cache histories isolated by session")

  // case: 删除会话时清理插件 storage
  const deleteSession = await newSession("delete-cleanup")
  await promptSession(deleteSession, "delete cleanup")
  await waitForCacheHistory(
    deleteSession,
    (history) => (history?.samples?.length ?? 0) > 0,
    "delete cleanup history",
  )
  setState(deleteSession, { v: 1, blocks: [], attempts: 0 })
  assert.notEqual(stateFor(deleteSession), undefined, "seed state must exist before delete")
  await api("DELETE", `/api/session/${deleteSession}`)
  const deleteDeadline = Date.now() + 10_000
  while (
    Date.now() < deleteDeadline &&
    (stateFor(deleteSession) !== undefined || cacheHistoryFor(deleteSession) !== undefined)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(stateFor(deleteSession), undefined, "state must be removed on session delete")
  assert.equal(
    cacheHistoryFor(deleteSession),
    undefined,
    "cache history must be removed on session delete",
  )
  console.log("case passed: session delete cleans plugin storage")

  // case: 缓存指令只追加在尾部，不重发 transcript
  mode = "normal"
  assert.ok(
    prompts.some((prompt) => prompt.includes("You are writing a checkpoint") && !prompt.includes("Sources:")),
    "T1 instruction should not include Sources transcript",
  )
  assert.ok(
    prompts.some(
      (prompt) =>
        prompt.includes("checkpoint at the top of the conversation") &&
        prompt.includes("Block group") &&
        !prompt.includes("Sources:"),
    ),
    "T2 instruction should not include Sources transcript",
  )
  console.log("case passed: cache-friendly instructions")
} finally {
  server.kill()
  await server.exited
  const stderr = serverStderr
  if (stderr.trim()) {
    const interesting = stderr
      .split(/\r?\n/)
      .filter((line) => /compaction|inbox|drain|session\.idle|E2E T1 failed|compress tool cache/i.test(line))
      .slice(-120)
    if (interesting.length > 0) console.error("server compaction logs:\n" + interesting.join("\n"))
  }
  fake.stop()
  // 服务端子进程（git 等）可能还占着临时目录；清理失败不能盖掉真正的断言错误。
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  // 无论成败都打：失败要看现场，成功要能证明「每一步实际发生了什么」，而不是只相信全绿。
  if (journal.length > 0) {
    console.error(
      `journal (${journal.length} entries, chronological):\n` +
        journal
          .map((entry) => `${entry.at} ${entry.kind.padEnd(5)} ${entry.detail}`)
          .join("\n"),
    )
  }
  if (prompts.length > 0) {
    console.error(
      "prompts tail:\n" +
        prompts
          .slice(-8)
          .map((prompt, index) => `${index}: ${prompt.slice(0, 120).replace(/\s+/g, " ")}`)
          .join("\n"),
    )
  }
}
