#!/usr/bin/env bun
/**
 * 输入：本机 opencode 2.x + bun。
 * 输出：在隔离 HOME/DB/config 里启动真实 TUI，注入一条带结构树的缓存突变记录，
 *       用真实鼠标事件测结构树行的悬浮底色与点击结果。
 * 预期：只读诊断，不改任何产品代码；打印悬浮前后的单元格颜色和点击后屏幕状态。
 *
 * 用法：bun scripts/e2e-drops-click.mjs
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Terminal } from "@xterm/headless"

import { resolveMessages } from "../src/i18n/index.ts"

// 界面语言随宿主 locale 变（CI 英文、本机可能中文）：断言只从语言文件取文案。
const copies = [resolveMessages("zh"), resolveMessages("en")]
/** 输入：屏幕 + 取文案的函数；输出：任一语言下该文案是否出现在屏幕上。 */
const shows = (text, pick) => copies.some((copy) => text.includes(pick(copy)))

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-drops-click-"))
for (const dir of ["config", "data", "state", "cache", "xdg-config"]) {
  await mkdir(join(root, dir), { recursive: true })
}

/** 输入：无；输出：OpenAI 兼容的普通文本响应。 */
function textResponse(text) {
  return {
    id: "chatcmpl-drops-click",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }
}

/** 输入：无；输出：OpenAI 兼容的流式文本响应。 */
function textStream(text) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-drops-click",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`
}

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = await request.json()
    const headers = { "content-type": "text/event-stream" }
    return body?.stream === true
      ? new Response(textStream("ok"), { headers })
      : Response.json(textResponse("ok"))
  },
})

const config = {
  plugins: [repo],
  compaction: { auto: false },
  model: "fake/fake",
  provider: {
    fake: {
      name: "Fake Drops",
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

const screen = new Terminal({ cols: 120, rows: 40, scrollback: 0, allowProposedApi: true })
const bin = process.env["OPENCODE_BIN"] ?? "opencode"
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

/** 输入：无；输出：当前整屏文本（每行去掉右侧空白）。 */
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

/** 输入：屏幕 + 文本；输出：行号；找不到 -1。 */
function rowOf(screenText, needle) {
  return screenText.split("\n").findIndex((line) => line.includes(needle))
}

/** 输入：屏幕行 + 字符下标；输出：终端显示列（CJK/emoji 占两列）。 */
function displayColumn(line, index) {
  let width = 0
  for (const char of Array.from(line).slice(0, index)) {
    width += (char.codePointAt(0) ?? 0) > 0x1100 ? 2 : 1
  }
  return width
}

/** 输入：屏幕坐标（0 基）；输出：无；预期：只移动鼠标。 */
async function move(x, y) {
  proc.terminal?.write(`\x1b[<35;${String(x + 1)};${String(y + 1)}M`)
  await Bun.sleep(300)
}

/** 输入：屏幕坐标（0 基）；输出：无；预期：按下与抬起连发。 */
async function click(x, y) {
  proc.terminal?.write(`\x1b[<0;${String(x + 1)};${String(y + 1)}M\x1b[<0;${String(x + 1)};${String(y + 1)}m`)
  await Bun.sleep(400)
}

/** 输入：坐标；输出：该单元格的背景色摘要。 */
function cellBg(x, y) {
  const cell = screen.buffer.active.getLine(y)?.getCell(x)
  if (cell === undefined) return "none"
  return `${String(cell.getBgColor())}${cell.isBgDefault() ? "(default)" : ""}`
}

/** 输入：无；输出：无；预期：结束进程、停服务器、清临时目录。 */
async function cleanup() {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
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
}

/** 输入：sessionID；输出：写入的 key；预期：把带树的 drop 塞进插件 storage。 */
function seedDrop(sessionID) {
  const key = `plugin:${Array.from(new TextEncoder().encode("compressed-context"))
    .map((byte) => `00${byte.toString(16).padStart(2, "0")}`)
    .join("")}:cache:history:${sessionID}`
  const drop = {
    messageID: "msg_probe",
    at: Date.now(),
    kind: "primary",
    prevMessageID: "msg_prev",
    prompt: 1000,
    hit: 400,
    hitRate: 40,
    prevPrompt: 1000,
    prevHit: 900,
    prevHitRate: 90,
    dropPp: 50,
    cause: "history",
    breakPoint: { segment: "messages[1]", offset: 1, before: "AAAA", after: "AABA" },
    outline: [{ key: "messages[0]", chars: 10 }],
    tree: [
      {
        key: "messages",
        chars: 100,
        children: [{ key: "[0]", chars: 50, text: '"hello"', truncated: false }],
      },
      { key: "model", chars: 4, text: '"m"', truncated: false },
    ],
  }
  const db = new Database(join(root, "opencode.db"))
  try {
    db.run("PRAGMA busy_timeout = 5000")
    db.query("insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)").run(
      key,
      JSON.stringify({ v: 2, samples: [], drops: [drop] }),
      Date.now(),
      Date.now(),
    )
  } finally {
    db.close()
  }
  return key
}

/** 输入：行 + 文案 + 判定；输出：命中的列偏移或 undefined；预期：试不同列偏移，兼容宽字符。 */
/** 输入：屏幕行 + 多语言文案数组；输出：第一个命中的行号；找不到 -1。 */
function rowOfAny(screenText, needles) {
  return screenText.split("\n").findIndex((line) => needles.some((needle) => line.includes(needle)))
}

/** 输入：屏幕行 + 多语言文案数组；输出：第一个命中的显示列；找不到 0。 */
function colAny(line, needles) {
  for (const needle of needles) {
    const index = line.indexOf(needle)
    if (index >= 0) return displayColumn(line, index)
  }
  return 0
}

async function clickUntil(row, line, needles, done, timeoutMs = 6000) {
  const base = colAny(line, needles)
  for (const dx of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
    await click(Math.max(0, base + dx), row)
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (done(plain())) return dx
      await Bun.sleep(200)
    }
  }
  return undefined
}

try {
  if (!(await waitFor((text) => /Ask anything|ctrl\+p commands/.test(text), 30_000))) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("TUI did not render")
  }

  // 先产生一个会话。
  proc.terminal?.write("hello")
  await Bun.sleep(400)
  proc.terminal?.write("\r")
  await waitFor((text) => text.includes("ok"), 60_000)

  /** 输入：无；输出：DB 里最新的 sessionID 或 undefined。 */
  const readSessionID = () => {
    const db = new Database(join(root, "opencode.db"), { readonly: true })
    try {
      const sessions = db.query("select id from session_v2 order by rowid desc limit 1").all()
      return sessions[0]?.id
    } finally {
      db.close()
    }
  }
  const hasSession = await waitFor(() => typeof readSessionID() === "string", 30_000)
  if (!hasSession) throw new Error("no session created")
  const sessionID = readSessionID()
  console.log(`session: ${sessionID}`)
  console.log(`seeded: ${seedDrop(sessionID)}`)

  // 打开缓存突变弹窗。
  proc.terminal?.write("/cache-drops")
  await Bun.sleep(600)
  proc.terminal?.write("\r")
  if (!(await waitFor((text) => shows(text, (c) => c.drops.structure), 20_000))) {
    console.log("=== screen ===")
    console.log(plain())
    throw new Error("drops dialog did not open")
  }

  // 先验证文本上的鼠标处理（esc）是否生效：点了应该关掉弹窗。
  let text = plain()
  const escLabels = copies.map((c) => c.drops.closeLabel)
  let escRow = rowOfAny(text, escLabels)
  let escLine = text.split("\n")[escRow] ?? ""
  await click(colAny(escLine, escLabels), escRow)
  await Bun.sleep(800)
  const escClosed = !shows(plain(), (c) => c.drops.panelTitle)
  console.log(`esc text click closes dialog: ${String(escClosed)}`)
  if (!escClosed) throw new Error("esc text click did not close the dialog")

  // 重新打开弹窗，测结构树标题的展开。
  proc.terminal?.write("/cache-drops")
  await Bun.sleep(600)
  proc.terminal?.write("\r")
  await waitFor((value) => shows(value, (c) => c.drops.structure), 20_000)

  const structureLabels = copies.map((c) => c.drops.structure)
  text = plain()
  let row = rowOfAny(text, structureLabels)
  let line = text.split("\n")[row] ?? ""
  const headerDx = await clickUntil(row, line, structureLabels, (value) => value.includes("messages (1)"))
  console.log(`header expand dx=${String(headerDx)}`)
  if (headerDx === undefined) {
    console.log("=== screen after header click ===")
    console.log(plain())
    throw new Error("tree header click did nothing")
  }
  await Bun.sleep(500)

  text = plain()
  row = text.split("\n").findIndex((value) => value.includes("messages ("))
  line = text.split("\n")[row] ?? ""
  if (row < 0) {
    console.log("=== screen after expand ===")
    console.log(plain())
    throw new Error("messages row missing")
  }

  // 树：点有子节点的行（messages）应该展开，而不是打开内容。
  const parentCol = displayColumn(line, Math.max(0, line.indexOf("messages")))
  console.log(`parent row=${String(row)} col=${String(parentCol)} line=${JSON.stringify(line)}`)
  let expandedTree = false
  for (let dx = -2; dx <= 14; dx += 1) {
    await click(Math.max(0, parentCol + dx), row)
    await Bun.sleep(400)
    const state = plain()
    if (state.includes("[0]")) {
      expandedTree = true
      console.log(`expand at dx=${String(dx)}`)
      break
    }
    if (shows(state, (c) => c.drops.nodeTitle)) {
      console.log(`dx=${String(dx)} opened content instead of expanding`)
      proc.terminal?.write("\u001b")
      await Bun.sleep(500)
      break
    }
  }
  console.log(`parent row expands: ${String(expandedTree)}`)
  if (!expandedTree) throw new Error("parent row did not expand")

  // 树：悬浮整行，比较背景色。
  text = plain()
  const modelRow = rowOf(text, "model")
  const bgBefore = cellBg(5, modelRow)
  await move(5, modelRow)
  const bgAfter = cellBg(5, modelRow)
  console.log(`hover bg: ${bgBefore} -> ${bgAfter}`)
  if (bgBefore === bgAfter) throw new Error("hover did not change row background")

  // 树：点叶子文字（不是行首）打开完整内容。
  const modelLine = plain().split("\n")[modelRow] ?? ""
  const labelCol = displayColumn(modelLine, Math.max(0, modelLine.indexOf("model")))
  await click(labelCol, modelRow)
  await Bun.sleep(800)
  const opened = shows(plain(), (c) => c.drops.nodeTitle)
  console.log(`click label opens content: ${String(opened)} (x=${String(labelCol)})`)
  if (!opened) throw new Error("clicking a leaf node did not open content")
} finally {
  await cleanup()
}
