#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 与 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动真实 TUI，等待原生压缩弹窗，
 *       回车选择“关闭原生自动压缩”，断言配置文件写入 auto: false。
 * 预期：不读写日常使用的 OpenCode 数据；失败时打印屏幕尾部。
 *
 * 用法：bun scripts/e2e-native-compaction.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-native-compaction-"))
for (const dir of ["config", "data", "state", "cache", "xdg-config"]) {
  await mkdir(join(root, dir), { recursive: true })
}

const config = {
  plugins: [repo],
  compaction: { auto: true },
  provider: {
    fake: {
      name: "Fake TUI",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "test" },
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

const chunks = []
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
      chunks.push(new TextDecoder().decode(data))
    },
  },
  env,
  cwd: repo,
})

/** 输入：原始终端输出；输出：去掉 ANSI 与回车的纯文本。 */
function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
}

/** 输入：无；输出：当前累积的纯文本。 */
const plain = () => stripAnsi(chunks.join(""))

/** 输入：判定函数 + 超时；输出：是否在超时前满足。 */
async function waitFor(predicate, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate(plain())) return true
    await Bun.sleep(250)
  }
  return false
}

/** 输入：判定函数 + 超时；输出：文件是否在超时前满足。 */
async function waitForFile(predicate, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await Bun.sleep(250)
  }
  return false
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
  const ready = await waitFor((text) => text.includes("OpenCode") || text.includes("opencode"), 25_000)
  if (!ready) {
    console.log("=== screen tail ===")
    console.log(plain().slice(-3000))
    throw new Error("TUI did not render in 25s")
  }

  const prompted = await waitFor(
    (text) =>
      text.includes("原生自动压缩") ||
      text.includes("native auto-compaction") ||
      text.includes("Turn off native"),
    15_000,
  )
  if (!prompted) {
    console.log("=== screen tail ===")
    console.log(plain().slice(-3000))
    throw new Error("native compaction prompt did not appear")
  }

  assert.ok(
    plain().includes("~/.config/opencode/opencode.json"),
    "config path must be visible in the dialog title",
  )

  // 第一个选项就是“关闭原生自动压缩”，回车选中。
  proc.terminal?.write("\r")
  const configPath = join(root, ".config", "opencode", "opencode.json")
  const written = await waitForFile(async () => {
    if (!(await Bun.file(configPath).exists())) return false
    const text = await Bun.file(configPath).text()
    return /"auto":\s*false/.test(text)
  }, 10_000)
  if (!written) {
    console.log("=== screen tail ===")
    console.log(plain().slice(-3000))
    throw new Error("config was not written with compaction.auto=false")
  }

  const text = await Bun.file(configPath).text()
  assert.match(text, /"auto":\s*false/, "config must disable native auto-compaction")
  assert.ok(!(await Bun.file(`${configPath}.bak`).exists()), "no backup file")
  console.log("case passed: real TUI prompt writes compaction.auto=false")
} finally {
  await cleanup()
}
