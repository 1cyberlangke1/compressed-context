import type { Messages } from "./types.ts"

/** 中文文案。标签控制在 4 个字以内，侧栏窄也能放下。 */
export const zh: Messages = {
  title: "上下文构成",
  labels: {
    system: "系统",
    tools: "工具定义",
    tool: "工具结果",
    text: "文本",
    summaries: "摘要",
    media: "媒体",
  },
  approximate: "~",
  command: {
    title: "压缩上下文设置",
    description: "打开上下文面板设置",
  },
  settings: {
    title: "上下文面板设置",
    show: "显示面板",
    expand: "展开面板",
    language: "语言",
    auto: "自动",
    on: "开",
    off: "关",
    close: "关闭",
  },
  languages: {
    zh: "中文",
    en: "English",
  },
}
