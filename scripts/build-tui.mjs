#!/usr/bin/env bun
/**
 * 输入：固定入口 `src/tui/main.tsx`。
 * 输出：`dist/tui.js`；成功时把体积打到 stderr，失败或产物不合规时退出码 1。
 * 预期：用 OpenTUI 自己的 Solid 变换预编译 TUI 的 JSX，并把所有宿主模块改写成
 *       `opentui:runtime-module:*` 虚拟 id；产物不依赖消费者环境的 tsconfig、JSX 设置或路径猜测。
 *
 * 为什么必须预编译：
 * `@opentui/solid/scripts/solid-plugin.js` 的 sourceFilter 硬编码跳过 node_modules，
 * 所以 npm 安装后的 `.tsx` 不会走 Solid 变换，会退回 Bun 默认的 react JSX，
 * 报 `Cannot find package 'react'`。预编译产物只有 jsx() 调用和虚拟 id 导入，
 * 无论宿主从哪个目录加载，都能拿到宿主的同一份 @opentui/solid 运行时。
 */

import { readFileSync, statSync, writeFileSync } from "node:fs"

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const RUNTIME_MODULE_PREFIX = "opentui:runtime-module:"
const ENTRY = "src/tui/main.tsx"
const OUT_DIR = "dist"
const OUT_FILE = `${OUT_DIR}/tui.js`

/** 输入：裸模块名；输出：宿主注册的虚拟 id。 */
function runtimeModuleId(specifier) {
  return `${RUNTIME_MODULE_PREFIX}${encodeURIComponent(specifier)}`
}

/** 输入：无；输出：产物里必须换成虚拟 id 的宿主模块。 */
const HOST_MODULES = ["solid-js", "solid-js/store", "@opentui/core", "@opencode/plugin/tui"]

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUT_DIR,
  naming: "tui.js",
  target: "bun",
  format: "esm",
  // 依赖一律不打包：宿主模块稍后换成虚拟 id，其余裸模块（node 内建等）交给运行时。
  packages: "external",
  plugins: [
    // Solid 变换只改文件内容，并把生成的运行时导入指向 @opentui/solid 的虚拟 id。
    createSolidTransformPlugin({ moduleName: runtimeModuleId("@opentui/solid") }),
    {
      name: "opentui-runtime-modules",
      setup(build) {
        // 虚拟 id 不是真实路径，必须声明为 external，否则构建器会尝试解析。
        build.onResolve({ filter: /^opentui:/ }, (args) => ({ path: args.path, external: true }))
      },
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

/**
 * 输入：产物文本。
 * 输出：把宿主模块的裸导入改写成虚拟 id 之后的文本。
 * 预期：只替换 import/export/require 里的完整字符串，不碰注释和普通字符串。
 */
function rewriteHostModules(source) {
  let output = source
  for (const specifier of HOST_MODULES) {
    const pattern = new RegExp(`(["'])${specifier.replaceAll("/", "\\/")}\\1`, "g")
    output = output.replaceAll(pattern, `"${runtimeModuleId(specifier)}"`)
  }
  return output
}

const rewritten = rewriteHostModules(readFileSync(OUT_FILE, "utf8"))

/** 输入：产物文本；输出：命中的禁用片段或 undefined。预期：react 与裸 jsx-runtime 都不能出现。 */
function findForbidden(source) {
  const patterns = [
    /["']react["']/,
    /["']react\/jsx-runtime["']/,
    /["']react\/jsx-dev-runtime["']/,
    /["']@opentui\/solid\/jsx-runtime["']/,
    /["']@opentui\/solid\/jsx-dev-runtime["']/,
    /["']solid-js["']/,
    /["']@opencode\/plugin\/tui["']/,
  ]
  return patterns.find((pattern) => pattern.test(source))
}

const forbidden = findForbidden(rewritten)
if (forbidden !== undefined) {
  console.error(`dist/tui.js still references ${forbidden.source}`)
  process.exit(1)
}

writeFileSync(OUT_FILE, rewritten)
console.error(`dist/tui.js ok: ${statSync(OUT_FILE).size.toString()} bytes`)
