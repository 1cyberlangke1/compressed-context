#!/usr/bin/env bun
/**
 * 输入：本机 opencode 2.x + bun。
 * 输出：在隔离 HOME/DB/config 里启动真实 TUI，让假 provider 触发一次 compress 生成摘要块，
 *       再用鼠标点开块、点 ✎ 进编辑器，改正文并保存。
 * 预期：不读写日常使用的 OpenCode 数据；保存后插件 storage 里的块正文真的变了。
 *
 * 用法：bun scripts/e2e-block-edit.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Terminal } from "@xterm/headless"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-block-edit-"))
for (const dir of ["config", "data", "state", "cache", "xdg-config"]) {
  await mkdir(join(root, dir), { recursive: true })
}

// 侧栏只留摘要分区，避免缓存图表把块列表挤出屏幕（e2e 要按坐标点击块行）。
await writeFile(
  join(root, "config", "compressed-context.json"),
  JSON.stringify({
    showCacheChart: false,
    showCacheLog: false,
    showSummaries: true,
    summariesExpanded: true,
  }),
  "utf8",
)

/** 摘要正文：超过 markdown 最短长度，且比原文小。 */
const SUMMARY = `# Editable block
## Goal
verify the block editor
## Facts
${"- zeta fact ".repeat(30)}`

/** 是否已经给过压缩工具调用。 */
let toolCalled = false

/** 输入：请求体；输出：是否是插件的摘要生成请求。 */
function isSummaryRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.some((message) => {
    const text =
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content.map((part) => part?.text ?? "").join("\n")
          : ""
    return text.includes("Return ONLY markdown")
  })
}

/** 输入：完成文本；输出：OpenAI 兼容的流式响应。 */
function textStream(text) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-block-edit",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`
}

/** 输入：工具调用；输出：OpenAI 兼容的流式响应。 */
function toolStream(name, args) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-block-edit-tool",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return `${chunk(
    { tool_calls: [{ index: 0, id: "call_compress_1", function: { name, arguments: "" } }] },
    null,
  )}${chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }, null)}${chunk(
    {},
    "tool_calls",
  )}data: [DONE]\n\n`
}

/** 输入：工具调用；输出：OpenAI 兼容的非流式响应。 */
function toolResponse(name, args) {
  return {
    id: "chatcmpl-block-edit-tool",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_compress_1", type: "function", function: { name, arguments: args } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }
}

/** 输入：完成文本；输出：OpenAI 兼容的非流式响应。 */
function textResponse(text) {
  return {
    id: "chatcmpl-block-edit",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }
}

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = await request.json()
    const headers = { "content-type": "text/event-stream" }
    const stream = body?.stream === true
    if (isSummaryRequest(body)) {
      return stream ? new Response(textStream(SUMMARY), { headers }) : Response.json(textResponse(SUMMARY))
    }
    // 只有真正带 compress 工具的那次 agent 请求才回工具调用；
    // 标题生成等辅助请求没有工具，回工具调用会被宿主当成无效响应。
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const userCount = messages.filter((message) => message?.role === "user").length
    const hasCompressTool = JSON.stringify(body?.tools ?? []).includes('"compress"')
    // 第一条消息还没有可压缩的历史，等第二条提问时再调用 compress。
    if (hasCompressTool && !toolCalled && userCount >= 2) {
      toolCalled = true
      const args = JSON.stringify({ markdown: SUMMARY })
      return stream
        ? new Response(toolStream("compress", args), { headers })
        : Response.json(toolResponse("compress", args))
    }
    return stream
      ? new Response(textStream("block is ready"), { headers })
      : Response.json(textResponse("block is ready"))
  },
})

const config = {
  plugins: [repo],
  compaction: { auto: false },
  // 必须显式钉住模型，否则 TUI 会用它的默认免费模型，请求根本到不了假 provider。
  model: "fake/fake",
  provider: {
    fake: {
      name: "Fake TUI",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${String(fake.port)}/v1`, apiKey: "test" },
      models: {
        fake: {
          name: "Fake",
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
  USERPROFILE: root,
  OPENCODE_CONFIG_DIR: join(root, "config"),
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  TERM: "xterm-256color",
}

// 用 headless 终端解析真实字节流，屏幕内容与坐标才是准的（裁剪字符串会错位）。
const screen = new Terminal({ cols: 120, rows: 40, scrollback: 0, allowProposedApi: true })

const bin = process.env.OPENCODE_BIN ?? "opencode"
const command =
  process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", `${bin} --standalone`]
    : [bin, "--standalone"]

const proc = Bun.spawn(command, {
  terminal: {
    cols: 120,
    rows: 40,
    data(_terminal, data) {
      screen.write(new TextDecoder().decode(data))
    },
  },
  env,
  cwd: repo,
})

/** 输入：无；输出：当前整屏文本（每行已去掉右侧空白）。 */
function plain() {
  const buffer = screen.buffer.active
  return Array.from({ length: screen.rows }, (_, row) =>
    buffer.getLine(row)?.translateToString(true) ?? "",
  ).join("\n")
}

/** 输入：判定函数 + 超时；输出：是否在超时前满足。 */
async function waitFor(predicate, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate(plain())) return true
    await Bun.sleep(250)
  }
  return false
}

/** 输入：无；输出：DB 里 compression:state 的原始文本。 */
async function readStateText() {
  if (!(await Bun.file(join(root, "opencode.db")).exists())) return ""
  const db = new Database(join(root, "opencode.db"), { readonly: true })
  try {
    const rows = db.query("select value from kv where key like '%:compression:state:%' limit 1").all()
    return rows.map((row) => String(row.value)).join("\n")
  } catch {
    return ""
  } finally {
    db.close()
  }
}

/** 输入：屏幕行 + 字符下标；输出：终端显示列（CJK/emoji 占两列）。 */
function displayColumn(line, index) {
  let width = 0
  for (const char of Array.from(line).slice(0, index)) {
    width += (char.codePointAt(0) ?? 0) > 0x1100 ? 2 : 1
  }
  return width
}

/** 输入：屏幕 + 文本；输出：行号；找不到 -1。 */
function rowOf(screenText, needle) {
  return screenText.split("\n").findIndex((line) => line.includes(needle))
}

/** 输入：屏幕坐标（0 基）；输出：无。预期：按下与抬起连发，宿主才认这次点击。 */
async function click(x, y) {
  proc.terminal?.write(`\x1b[<0;${String(x + 1)};${String(y + 1)}M\x1b[<0;${String(x + 1)};${String(y + 1)}m`)
  await Bun.sleep(250)
}

/** 输入：无；输出：无。预期：先杀进程树，再关 PTY，最后清临时目录。 */
async function cleanup() {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      })
    } else {
      proc.kill()
    }
  } catch {
    // 进程可能已经退出
  }
  await Bun.sleep(800)
  try {
    proc.terminal?.close()
  } catch {
    // PTY 可能已经关闭
  }
  try {
    fake.stop(true)
  } catch {
    // 已经停止
  }
  if (process.env["KEEP"] === "1") {
    console.log(`kept: ${root}`)
    return
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(500)
    }
  }
  console.log(`note: temp dir left behind: ${root}`)
}

try {
  const ready = await waitFor((text) => /Ask anything|ctrl\+p commands/.test(text), 30_000)
  if (!ready) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("TUI did not render in 30s")
  }

  // 1. 先灌长上下文（compress 要求原文 ≥5000 字符），第二条提问时假 provider 调 compress。
  const filler = `please remember this context ${"filler-context ".repeat(400)}`
  proc.terminal?.write(filler)
  await Bun.sleep(600)
  proc.terminal?.write("\r")
  await waitFor((text) => text.includes("block is ready"), 60_000)
  await Bun.sleep(500)
  proc.terminal?.write("now compress")
  await Bun.sleep(400)
  proc.terminal?.write("\r")

  const stored = await (async () => {
    const start = Date.now()
    while (Date.now() - start < 90_000) {
      if ((await readStateText()).includes('"id":"b1"')) return true
      await Bun.sleep(500)
    }
    return false
  })()
  if (!stored) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("compressed block was not stored")
  }

  // 2. 侧栏默认是收起的：用命令面板打开（session.sidebar.toggle），再等块行出现。
  if (rowOf(plain(), "b1 :") < 0) {
    proc.terminal?.write("\u0010")
    await Bun.sleep(800)
    proc.terminal?.write("sidebar")
    await Bun.sleep(800)
    proc.terminal?.write("\r")
    await Bun.sleep(1200)
  }
  const listed = await waitFor((text) => rowOf(text, "b1 :") >= 0, 30_000)
  if (!listed) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("summary block row did not appear")
  }
  const listScreen = plain()
  const blockRow = rowOf(listScreen, "b1 :")
  const blockLine = listScreen.split("\n")[blockRow] ?? ""
  const blockColumn = displayColumn(blockLine, blockLine.indexOf("b1 :"))
  await click(Math.max(0, blockColumn), blockRow)

  const readerReady = await waitFor((text) => {
    const row = rowOf(text, "esc")
    return row >= 0 && text.includes("✎")
  }, 15_000)
  if (!readerReady) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("reader dialog did not open")
  }

  // 3. 点 ✎ 进编辑器（✎ 在 esc 左边一格）。
  const readerScreen = plain()
  const escRow = rowOf(readerScreen, "esc")
  const escLine = readerScreen.split("\n")[escRow] ?? ""
  const escColumn = escLine.indexOf("esc")
  const editColumn = escLine.lastIndexOf("✎")
  const editX = editColumn >= 0 ? displayColumn(escLine, editColumn) : displayColumn(escLine, escColumn) - 2
  let editing = false
  // ✎ 很窄，允许左右各差一格。
  for (const dx of [0, -1, 1, -2]) {
    await click(editX + dx, escRow)
    editing = await waitFor(
      (text) => text.includes("ctrl+s 保存") || text.includes("ctrl+s save"),
      4_000,
    )
    if (editing) break
  }
  if (!editing) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("editor did not open")
  }

  // 4. 正文预填了原内容：直接打字（光标在开头）再点保存按钮。
  proc.terminal?.write("ZMARK")
  await Bun.sleep(400)
  const editorScreen = plain()
  /** 输入：超时；输出：状态里是否已经出现改动标记。 */
  const waitSaved = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await readStateText()).includes("ZMARK")) return true
      await Bun.sleep(400)
    }
    return false
  }

  // 依次尝试三个入口，并把真正生效的那个打印出来（真实终端里 ctrl+s 可能被流控吞掉）。
  let saved = false
  if (!saved) {
    proc.terminal?.write("\x13")
    saved = await waitSaved(2_500)
    if (saved) console.log("saved via ctrl+s")
  }
  if (!saved) {
    proc.terminal?.write("\u001bs")
    saved = await waitSaved(2_500)
    if (saved) console.log("saved via alt+s")
  }
  if (!saved) {
    const saveRow = rowOf(editorScreen, "保存") >= 0 ? rowOf(editorScreen, "保存") : rowOf(editorScreen, "Save")
    const saveLine = editorScreen.split("\n")[saveRow] ?? ""
    const saveColumn = saveLine.includes("保存") ? saveLine.indexOf("保存") : saveLine.indexOf("Save")
    if (saveRow >= 0 && saveColumn >= 0) {
      await click(displayColumn(saveLine, saveColumn), saveRow)
      saved = await waitSaved(5_000)
      if (saved) console.log("saved via save button")
    }
  }
  if (!saved) {
    console.log("=== screen ===")
    console.log(plain())
    console.log("=== state ===")
    console.log((await readStateText()).slice(0, 800))
    throw new Error("edited block was not persisted")
  }

  // 保存成功必须有可见反馈（toast）。
  const feedback = await waitFor((text) => text.includes("已保存") || text.includes("Saved"), 8_000)
  if (!feedback) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("save toast did not appear")
  }

  assert.ok(toolCalled, "fake provider must have served the compress call")
  console.log("case passed: real TUI block edit persists through the plugin RPC")
} finally {
  await cleanup()
}


