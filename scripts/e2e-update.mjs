#!/usr/bin/env bun
/**
 * 输入：本机 opencode 2.x + bun。
 * 输出：在隔离 HOME/DB/config/PATH 里启动真实 TUI，用本地假 registry 驱动更新检查。
 * 预期：中文成功场景先确认再原地展示进度并执行固定命令；英文失败场景直接展示失败提示。
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
import { PLUGIN_VERSION } from "../src/shared/version.ts"

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
    await writeFile(join(root, "release-update"), "", "utf8")
  } catch {
    // 临时目录可能已不可写；继续清理进程。
  }
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

/** 输入：临时目录；输出：命令目录与日志路径。预期：只记录固定命令参数。 */
async function createFakeOpencode(root) {
  const logPath = join(root, "update-command.log")
  const runnerPath = join(root, "fake-update.mjs")
  const path = join(root, process.platform === "win32" ? "opencode.cmd" : "opencode")
  await writeFile(
    runnerPath,
    [
      'import { appendFileSync, existsSync } from "node:fs"',
      'const log = process.env["UPDATE_COMMAND_LOG"]',
      'const release = process.env["UPDATE_RELEASE_FILE"]',
      "if (!log || !release) process.exit(1)",
      'await Bun.write(log, `plugin update compressed-context\\nrelease=${release}\\n`)',
      'process.stdout.write("Downloading package...\\n")',
      "while (!existsSync(release)) await Bun.sleep(50)",
      'appendFileSync(log, "released\\n")',
      'process.stdout.write("Updated package\\n")',
      "",
    ].join("\n"),
    "utf8",
  )
  const content =
    process.platform === "win32"
      ? '@echo off\r\nbun "%FAKE_UPDATE_SCRIPT%" %*\r\n'
      : '#!/bin/sh\nexec bun "$FAKE_UPDATE_SCRIPT" "$@"\n'
  await writeFile(path, content, "utf8")
  if (process.platform !== "win32") await chmod(path, 0o755)
  return { commandDir: root, logPath, runnerPath }
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
  const releasePath = join(root, "release-update")
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
    FAKE_UPDATE_SCRIPT: fake.runnerPath,
    UPDATE_RELEASE_FILE: releasePath,
    UPDATE_COMMAND_LOG: fake.logPath,
    PATH: `${fake.commandDir}${delimiter}${process.env.PATH ?? ""}`,
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
    // Windows 的 cmd 会先查当前目录；把 TUI 跑在沙箱根目录即可稳定命中假命令。
    cwd: root,
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
    assert.ok(
      await waitFor(
        (text) => hasText(text, `${copy.update.checkUpdates} v${PLUGIN_VERSION}`),
        plain,
      ),
      "update entry did not show current version",
    )
    // 菜单自带搜索框；输入唯一的入口文案后等它实际渲染，再单独提交。
    // 这样不会把导航键和确认键塞进同一批输入，避免对话框按键竞态。
    proc.terminal?.write(copy.update.checkUpdates)
    assert.ok(
      await waitFor((text) => text.split(copy.update.checkUpdates).length > 2, plain),
      "update entry filter did not settle",
    )
    proc.terminal?.write("\r")

    if (updateAvailable) {
      assert.ok(
        await waitFor(
          (text) => hasText(text, copy.update.confirm(PLUGIN_VERSION, "9.9.9")),
          plain,
          12_000,
        ),
        "update confirmation did not open",
      )
      proc.terminal?.write("\r")
      assert.ok(
        await waitFor((text) => hasText(text, "Downloading package..."), plain, 8_000),
        "update progress did not appear in TUI",
      )
      await writeFile(releasePath, "", "utf8")
      const completed = await waitFor((text) => hasText(text, copy.update.succeeded), plain, 8_000)
      if (!completed) {
        console.log("=== update log ===")
        console.log(await readFile(fake.logPath, "utf8"))
        console.log("=== screen tail ===")
        console.log(plain().slice(-3000))
        throw new Error("update completion did not appear in TUI")
      }
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
        console.log("=== update screen before submit ===")
        console.log("=== screen tail after submit ===")
        console.log(plain().slice(-3000))
        throw new Error("fake opencode did not receive the update command")
      }
      const commandLine = (await readFile(fake.logPath, "utf8")).trim()
      assert.match(commandLine, /plugin update compressed-context/)
      console.log("update command:", commandLine)
    } else {
      assert.ok(
        await waitFor((text) => hasText(text, copy.update.failed), plain, 12_000),
        "failed update check alert did not open",
      )
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
