# compressed-context

OpenCode 的上下文压缩插件：把变长的旧历史折叠成自包含摘要块，让长会话在有限窗口里继续跑下去。

## 功能

- **自动压缩**：上下文占用达到阈值时自动入队，工具循环里的后续 step 也能触发
- **手动压缩**：模型可主动调用 `compress` 工具，在任意时刻打检查点
- **分层摘要**：T1 压缩当前对话流；T2 / T3 合并相邻摘要，层级单调递减
- **解压**：`decompress` 还原某个块覆盖的原始消息，可只还原下一层或展开到原文
- **缓存友好**：压缩请求保持前缀不变，尽量减少缓存未命中
- **摘要格式**：Markdown（默认）或 Babel（首行 `T=标题|G=目标`，正文自由高密度）
- **主动提醒**：上下文增长超过设定值时，在请求尾部追加一次提醒，让模型自己决定何时压缩
- **TUI 面板**：查看摘要块、缓存命中率、上下文构成，设置项在插件设置里直接改

## 安装

插件通过 npm 分发，OpenCode 会在启动时自行安装。

### 方式一：npm 包名（推荐）

在 OpenCode 配置里加入 `plugin` 数组（全局配置 `~/.config/opencode/opencode.json`，或项目内 `opencode.json`）：

```json
{
  "plugin": ["compressed-context"]
}
```

### 方式二：本地路径

从源码使用或自己改代码时，直接指向仓库目录：

```json
{
  "plugin": ["/absolute/path/to/compressed-context"]
}
```

### 配置建议

插件会接管上下文压缩，建议关掉 OpenCode 原生自动压缩，避免两套策略互相干扰：

```json
{
  "plugin": ["compressed-context"],
  "compaction": { "auto": false }
}
```

## 配置项

都能在 TUI 的插件设置里改，也可以通过设置接口写入：

| 键 | 默认 | 说明 |
|---|---|---|
| `contextLimit` | `"auto"` | 上下文窗口上限；数字表示上限，实际取它与模型原生窗口的较小值 |
| `triggerPercent` | `80` | 占用达到窗口的百分之多少时自动压缩 |
| `autoCompress` | 开 | 是否允许自动压缩 |
| `summaryBlockPercent` | 单条摘要占窗口的百分比 | 单个摘要块的 token 预算 |
| `summaryTotalPercent` | 全部摘要占窗口的百分比 | 摘要总量预算，超过后触发 T2 / T3 |
| `summaryFormat` | `markdown` | `markdown` 或 `babel` |
| `summaryLanguage` | `auto` | 摘要语言；`babel` 格式下忽略 |
| `nudgeGrowthTokens` | `50000` | 主动提醒的增长阈值，`0` 关闭 |
| `enableCompressTool` | 开 | 是否暴露 `compress` 工具 |
| `enableDecompressTool` | 开 | 是否暴露 `decompress` 工具 |

## 开发

```bash
pnpm install
pnpm check          # typecheck + lint + 单测 + TUI 测试
bun scripts/e2e-nudge.mjs      # 隔离环境 + 假 provider 的提醒 e2e
bun scripts/e2e-tool-loop.mjs  # 工具循环里的自动压缩 e2e
```

## 基准

在 Terminal-Bench 的 `schemelike-metacircular-eval` 上做过一次粗略对比：100k 窗口下插件把单步上下文
压在 93,560 并让该次运行通过验证。**只跑了一次，波动很大，只能当参考**，详见
[docs/benchmark.md](docs/benchmark.md)。

## 协议

[MIT](LICENSE) © 1cyberlangke1

## 灵感

- [billion-context](https://github.com/ranxianglei/billion-context)
- [Large Language Models Do Not Always Need Readable Language](https://arxiv.org/abs/2606.19857) —— Babel 摘要格式的出处（BabelTele）
