#!/usr/bin/env bun
/**
 * 输入：本机 opencode 2.x + bun。
 * 输出：在隔离 HOME/DB/config/PATH 里启动真实 TUI，用本地假 registry 驱动更新检查。
 * 预期：中文成功场景展示更新结果并执行固定命令；英文失败场景展示失败态且不崩。
 *       假 opencode 只记录参数，不会真的安装或修改本机插件。
 *
 * 用法：bun scripts/e2e-update.mjs
 */

import { strict as assert } from "node:assert"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { Terminal } from "@xterm/headless"

import { resolveMessages } from "../src/i18n/index.ts"

const repo = process.cwd()
const realOpencode =
  process.env["OPENCODE_BIN"] ??
  Bun.which(process.platform === "win32" ? "opencode.cmd" : "opencode")
if (realOpencode === null || realOpencode === undefined) {
  throw new Error("opencode executable not found")
}

let registryVersion = "9.9.9"
let registryStatus = 200
const registryRequests = []
const registry = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    registryRequests.push(url.pathname)
    if (registryStatus !== 200) return new Response("registry unavailable", { status: registryStatus })
    if (url.pathname === "/compressed-context/latest") return Response.json({ version: registryVersion })
    return new Response("not found", { status: 404 })
  },
})

/** 输入：终端文本 + 期望文案；输出：忽略换行/空格后是否包含。 */
function hasText(text, expected) {
  return text.replace(/\s+/g, "").includes(expected.replace(/\s+/g, ""))
}

/** 输入：判定函数、当前文本访问器与超时；输出：是否在超时前满足。 */
async function waitFor(predicate, plain, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate(plain())) return true
    await Bun.sleep(200)
  }
  return false
}

/** 输入：进程、终端文本访问器、临时目录、假命令目录；输出：无。预期：清理本次场景。 */
async function cleanup(proc, root) {
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
    // 进程可能已退出。
  }
  await Bun.sleep(600)
  try {
    proc.terminal?.close()
  } catch {
    // PTY 可能已关闭。
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(400)
    }
  }
}

/** 输入：临时目录；输出：假 opencode 可执行路径。预期：只记录固定命令参数。 */
async function createFakeOpencode(root) {
  const binDir = join(root, "bin")
  await mkdir(binDir, { recursive: true })
  const logPath = join(root, "update-command.log")
  const path = join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode")
  const content =
    process.platform === "win32"
      ? '@echo off\r\n> "%UPDATE_COMMAND_LOG%" echo %*\r\n'
      : '#!/bin/sh\nprintf "%s\\n" "$*" > "$UPDATE_COMMAND_LOG"\n'
  await writeFile(path, content, "utf8")
  if (process.platform !== "win32") await chmod(path, 0o755)
  return { binDir, logPath }
}

/**
 * 输入：语言、registry 响应、是否期待立即更新。
 * 输出：无。
 * 预期：通过真实 TUI 完成检查；成功场景选择立即更新并断言假命令日志。
 */
async function runScenario({ locale, version, status, updateAvailable }) {
  const copy = resolveMessages(locale)
  registryVersion = version
  registryStatus = status

  const root = await mkdtemp(join(tmpdir(), `opencode-e2e-update-${locale}-`))
  const configDir = join(root, "config")
  for (const name of ["config", "data", "state", "cache", "xdg-config"]) {
    await mkdir(join(root, name), { recursive: true })
  }
  await writeFile(join(configDir, "compressed-context.json"), `${JSON.stringify({ locale }, null, 2)}\n`, "utf8")
  const fake = await createFakeOpencode(root)
  const terminalScreen = new Terminal({ cols: 120, rows: 40, scrollback: 0, allowProposedApi: true })

  const config = {
    plugins: [repo],
    compaction: { auto: false },
    provider: {
      fake: {
        name: "Fake Update",
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
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    COMPRESSED_CONTEXT_REGISTRY_URL: `http://127.0.0.1:${registry.port}`,
    UPDATE_COMMAND_LOG: fake.logPath,
    PATH: `${fake.binDir}${delimiter}${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
  }
  const command =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", `${realOpencode} --standalone`]
      : [realOpencode, "--standalone"]
  const proc = Bun.spawn(command, {
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        terminalScreen.write(new TextDecoder().decode(data))
      },
    },
    env,
    cwd: repo,
  })
  const plain = () => {
    const buffer = terminalScreen.buffer.active
    return Array.from({ length: terminalScreen.rows }, (_, row) =>
      buffer.getLine(row)?.translateToString(true) ?? "",
    ).join("\n")
  }

  try {
    const ready = await waitFor(
      (text) => !text.includes("Finishing startup") && /Ask anything|ctrl\+p commands/.test(text),
      plain,
      25_000,
    )
    if (!ready) {
      console.log("=== current screen ===")
      console.log(plain())
      throw new Error("TUI did not become ready")
    }
    proc.terminal?.write("/compressed-context")
    assert.ok(await waitFor((text) => hasText(text, "/compressed-context"), plain), "slash command was not accepted")
    proc.terminal?.write("\r")
    assert.ok(
      await waitFor((text) => hasText(text, copy.update.checkUpdates), plain, 25_000),
      "settings menu did not show update entry",
    )
    proc.terminal?.write("\x1b[F\r")
    const opened = await waitFor((text) => hasText(text, copy.update.current), plain, 12_000)
    if (!opened) {
      console.log("=== screen tail ===")
      console.log(plain().slice(-3000))
      throw new Error("update result menu did not open")
    }
    const screen = plain()
    assert.ok(hasText(screen, copy.update.current), "current version label missing")
    assert.ok(hasText(screen, copy.update.latest), "latest version label missing")
    const expectedStatus = updateAvailable
      ? copy.update.available
      : copy.update.failed
    assert.ok(hasText(screen, expectedStatus), `missing update status: ${expectedStatus}`)

    if (updateAvailable) {
      assert.ok(hasText(screen, copy.update.updateNow), "update action missing")
      assert.ok(screen.includes("v9.9.9"), "latest version footer missing")
      proc.terminal?.write("\r")
      const logged = await waitFor(
        async () => {
          try {
            return (await readFile(fake.logPath, "utf8")).trim().length > 0
          } catch {
            return false
          }
        },
        () => "",
        8_000,
      )
      if (!logged) {
        console.log("=== screen tail ===")
        console.log(plain().slice(-3000))
        throw new Error("fake opencode did not receive the update command")
      }
      const commandLine = (await readFile(fake.logPath, "utf8")).trim()
      assert.match(commandLine, /plugin update compressed-context/)
      console.log("update command:", commandLine)
    } else {
      assert.ok(!hasText(screen, copy.update.updateNow), "failed check must not offer update")
      assert.ok(hasText(screen, copy.update.checkAgain), "check again action missing")
      assert.ok(hasText(screen, copy.update.close), "close action missing")
    }

    assert.deepEqual(registryRequests.at(-1), "/compressed-context/latest")
    console.log(`case passed: ${locale} update ${updateAvailable ? "available" : "failure"}`)
  } finally {
    await cleanup(proc, root)
  }
}

try {
  await runScenario({ locale: "zh", version: "9.9.9", status: 200, updateAvailable: true })
  await runScenario({ locale: "en", version: "", status: 503, updateAvailable: false })
} finally {
  registry.stop()
}
