#!/usr/bin/env bun
/**
 * 输入：可选环境变量
 *   CI_PLUGIN_SPEC       覆盖被测包（形如 `pkg@1.2.3`），用于故意验证“坏版本会红”
 *   CI_PLUGIN_TIMEOUT_MS 等待 TUI 加载的超时，默认 90000
 *   CI_PLUGIN_KEEP=1     保留临时目录，便于排查
 * 输出：进程退出码 0 表示加载成功；非 0 表示加载失败并打印日志命中行与尾部。
 * 预期：openCode 按“包名”从 npm 缓存位置加载插件，服务端入口与 TUI 入口都完成 setup，
 *       且全程没有 failed to load plugin / Cannot find package 之类的失败标记。
 *
 * 为什么要预置缓存：OpenCode 的 Npm.install 在缓存里已有
 * `<cache>/npm/<name>@<version>/<generation>/node_modules/<name>` 时直接返回（不联网），
 * 因此这样预置能以“已从 npm 安装”的形态加载，走的正是 exports["./tui"] → dist/tui.js 这条真路径。
 */

import { strict as assert } from "node:assert"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const repo = dirname(import.meta.dir)
const specOverride = process.env["CI_PLUGIN_SPEC"]
const timeoutMs = Number(process.env["CI_PLUGIN_TIMEOUT_MS"] ?? 90_000)
const keep = process.env["CI_PLUGIN_KEEP"] === "1"
const registry = "https://registry.npmjs.org"

/** 输入：命令名与参数；输出：可直接交给 Bun.spawn 的 argv。预期：Windows 经 cmd.exe。 */
function argv(bin, args) {
  if (process.platform !== "win32") return [bin, ...args]
  const quoted = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
  return ["cmd.exe", "/d", "/s", "/c", [bin, ...quoted].join(" ")]
}

/** 输入：命令与工作目录；输出：stdout 文本。预期：非零退出直接抛错并带上 stderr。 */
function runSync(bin, args, cwd) {
  const result = Bun.spawnSync(argv(bin, args), { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} failed (${result.exitCode})\n${result.stderr.toString()}\n${result.stdout.toString()}`,
    )
  }
  return result.stdout.toString()
}

const root = await mkdtemp(join(tmpdir(), "oc-plugin-load-"))

/** 输入：无；输出：无。预期：清理临时目录，KEEP=1 时保留。 */
async function cleanup() {
  if (keep) {
    console.log(`kept: ${root}`)
    return
  }
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

try {
  const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"))
  const name = manifest.name
  assert.ok(typeof name === "string" && name.length > 0, "package.json 缺少 name")

  // 被测包：默认打包当前工作区，CI_PLUGIN_SPEC 时改为装指定已发布版本。
  let target
  let version
  if (specOverride === undefined) {
    const packed = runSync("npm", ["pack", "--pack-destination", root, "--registry", registry], repo)
    const file = packed.trim().split(/\r?\n/).at(-1)
    assert.ok(file !== undefined && file.endsWith(".tgz"), `npm pack 没有输出 tgz：${packed}`)
    target = join(root, file)
    version = manifest.version
  } else {
    const at = specOverride.lastIndexOf("@")
    assert.ok(at > 0 && at < specOverride.length - 1, "CI_PLUGIN_SPEC 必须是 name@version")
    target = specOverride
    version = specOverride.slice(at + 1)
  }
  assert.ok(typeof version === "string" && version.length > 0, "无法确定被测版本")

  // 预置 OpenCode 的 npm 缓存：generation 目录名必须全数字（util/src/npm.ts 只认 /^\d+$/）。
  const key = `${name}@${version}`
  const generation = join(root, "cache", "opencode", "npm", key, String(Date.now()))
  await mkdir(generation, { recursive: true })
  await writeFile(join(generation, "package.json"), JSON.stringify({ name: "ci-load-fixture", private: true }))
  runSync("npm", ["install", target, "--no-audit", "--no-fund", "--registry", registry], generation)

  const installedDir = join(generation, "node_modules", name)
  assert.ok(existsSync(join(installedDir, "package.json")), `安装后找不到 ${installedDir}/package.json`)

  const logPath = join(root, "data", "opencode", "log", "opencode.log")
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
    OPENCODE_DB: join(root, "data", "opencode", "opencode.db"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [key] }),
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    npm_config_registry: registry,
    NPM_CONFIG_REGISTRY: registry,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  }
  await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })

  const chunks = []
  const bin = process.env["OPENCODE_BIN"] ?? "opencode"
  const proc = Bun.spawn(argv(bin, ["--standalone", "--print-logs", "--log-level", "debug"]), {
    cwd: root,
    env,
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        chunks.push(new TextDecoder().decode(data))
      },
    },
  })

  /** 输入：无；输出：目前能看到的全部日志（终端输出 + 日志文件）。 */
  async function harvest() {
    const file = existsSync(logPath) ? await readFile(logPath, "utf8").catch(() => "") : ""
    return `${chunks.join("")}\n${file}`
  }

  const tuiReady = /stage=setup(?=[^\n]*plugin=\S*\.tui)/
  const failures = [
    /failed to load plugin/i,
    /plugin operation failed/i,
    /cannot find package/i,
    /plugin failed/i,
  ]

  let failure = null
  let ready = false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await harvest()
    const hit = failures.find((pattern) => pattern.test(text))
    if (hit !== undefined) {
      failure = hit
      break
    }
    if (text.includes("loading plugin") && tuiReady.test(text)) {
      ready = true
      break
    }
    await Bun.sleep(300)
  }

  const text = await harvest()

  /** 输入：无；输出：无。预期：结束 TUI 进程并关闭 pty。 */
  async function stop() {
    try {
      if (process.platform === "win32") {
        Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
      } else {
        proc.kill()
      }
    } catch {
      // 进程可能已经退出
    }
    await Bun.sleep(500)
    try {
      proc.terminal?.close()
    } catch {
      // pty 可能已经关闭
    }
  }

  await stop()

  if (failure !== null || !ready) {
    const interesting = text
      .split(/\r?\n/)
      .filter((line) => /loading plugin|failed|error|cannot find|\.tui/i.test(line))
      .slice(-30)
      .join("\n")
    console.log(`plugin-load FAILED for ${key} (${failure ? `matched ${String(failure)}` : "timeout"})`)
    console.log(`---- interesting ----\n${interesting}`)
    console.log(`---- tail ----\n${text.slice(-4000)}`)
    await cleanup()
    process.exit(1)
  }

  console.log(`plugin-load ok: ${key}`)
  for (const line of text.split(/\r?\n/)) {
    if (/loading plugin|plugin=\S*\.tui/.test(line)) console.log(`  ${line.trim()}`)
  }
  await cleanup()
} catch (error) {
  console.error(`plugin-load error: ${error instanceof Error ? error.message : String(error)}`)
  await cleanup()
  process.exit(1)
}
