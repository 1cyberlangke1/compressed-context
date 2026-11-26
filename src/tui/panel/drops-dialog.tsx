import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import { formatHitRate } from "../../shared/cache.ts"
import type { CacheDrop, CacheDropNode } from "../../shared/cache-drops.ts"
import { valueAtPath } from "../../shared/cache-drops.ts"
import { formatTokens } from "../../shared/format.ts"
import { localeArgument, type Settings } from "../../shared/settings.ts"
import { DropCompare } from "./drops-compare.tsx"
import { usePanelData } from "./data-scoped.ts"
import { groupOutline, prettyJsonLines, segmentLabel, splitExcerpt, timeLabel } from "./drops-format.ts"

/** 列表默认可见行数上限；终端更高也不会把详情挤没。 */
const MAX_LIST_ROWS = 6
/** 列表最少行数；终端很矮时也保证能点两条。 */
const MIN_LIST_ROWS = 3

/** 输入：跌幅（百分点）；输出：火花线字符。预期：跌幅越大越实心。 */
function barGlyph(dropPp: number): string {
  const glyphs = "▁▂▃▄▅▆▇█"
  const ratio = Math.min(1, Math.max(0, dropPp / 100))
  return glyphs[Math.min(glyphs.length - 1, Math.floor(ratio * glyphs.length))] ?? "▁"
}

/** 输入：跌幅 + 主题；输出：主题色 token。预期：≥30pp 用错误色，其余用警告色。 */
function barColor(dropPp: number, theme: Context["theme"]): Context["theme"]["text"]["base"] {
  return dropPp >= 30 ? theme.text.feedback.error.base : theme.text.feedback.warning.base
}

/** 输入：符号 + 正文 + 颜色；输出：`-`/`+` 行，正文按词换行。预期：差异段完整显示。 */
function DiffLine(props: {
  readonly sign: string
  readonly text: string
  readonly color: Context["theme"]["text"]["base"]
}) {
  return (
    <box flexDirection="row" gap={1} width="100%">
      <text fg={props.color} width={1} flexShrink={0}>
        {props.sign}
      </text>
      <text fg={props.color} flexGrow={1} wrapMode="word">
        {props.text}
      </text>
    </box>
  )
}

/**
 * 输入：TUI 上下文 + 会话 + 设置 + 可选初始选中记录。
 * 输出：占满弹窗宽度的「缓存突变记录」阅读界面：概览、列表、差异详情。
 * 预期：点列表行切换记录；esc 或右上角 esc 关闭；没有记录时只显示空态。
 */
export function DropsDialog(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly initial?: string
}) {
  const theme = props.context.theme
  const copy = createMemo(() => resolveMessages(localeArgument(props.settings.locale)))
  const data = usePanelData({
    context: props.context,
    sessionID: props.sessionID,
    settings: () => props.settings,
    scope: "drops",
  })

  const [selected, setSelected] = createSignal<string | undefined>(props.initial)
  const [hovered, setHovered] = createSignal(false)
  const [comparing, setComparing] = createSignal(false)
  const [nodeView, setNodeView] = createSignal<{
    readonly node: CacheDropNode
    readonly path: readonly string[]
    readonly body: string | undefined
  }>()

  // 对比页和节点内容是同一个弹窗里的下一层：esc 先退回上一层，最外层才交给宿主关闭。
  props.context.keymap.layer(() => ({
    mode: "global",
    enabled: nodeView() !== undefined || comparing(),
    priority: 100,
    commands: [
      {
        id: "compressed-context.drops.back",
        title: nodeView() !== undefined ? copy().drops.nodeTitle : copy().drops.compareTitle,
        bind: "escape",
        run() {
          if (nodeView() !== undefined) {
            setNodeView(undefined)
            return
          }
          setComparing(false)
        },
      },
    ],
  }))

  /** 最新在上；点击行只改选中，不关弹窗。 */
  const drops = createMemo(() => data.drops().toReversed())
  const active = createMemo(() => {
    const list = drops()
    if (list.length === 0) return undefined
    return list.find((drop) => drop.messageID === selected()) ?? list[0]
  })
  const listHeight = createMemo(() =>
    Math.max(MIN_LIST_ROWS, Math.min(MAX_LIST_ROWS, Math.floor(props.context.renderer.height / 8))),
  )
  /** 详情区吃掉剩余高度；给标题、火花线、列表和底部提示留出固定行数。 */
  const detailHeight = createMemo(() =>
    Math.max(6, Math.min(30, props.context.renderer.height - listHeight() - 14)),
  )
  const escColor = () =>
    hovered() ? theme.text.feedback.error.base : theme.text.muted

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1} width="100%">
      <Show when={nodeView()}>
        {(view) => (
          <NodeTextDialog
            context={props.context}
            copy={copy()}
            node={view().node}
            path={view().path}
            body={view().body}
            onBack={() => {
              setNodeView(undefined)
            }}
          />
        )}
      </Show>
      <Show when={nodeView() === undefined && comparing()}>
        <Show
          when={active()}
          fallback={<text fg={theme.text.muted}>{copy().drops.empty}</text>}
        >
          {(drop) => (
            <DropCompare
              context={props.context}
              sessionID={props.sessionID}
              drop={drop()}
              copy={copy()}
              onBack={() => {
                setComparing(false)
              }}
            />
          )}
        </Show>
      </Show>
      <Show when={nodeView() === undefined && !comparing()}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.base} wrapMode="word">
            <b>{copy().drops.panelTitle}</b>
          </text>
          <text fg={theme.text.muted}>{`(${drops().length.toString()})`}</text>
        </box>
        <text
          fg={escColor()}
          flexShrink={0}
          onMouseOver={() => {
            setHovered(true)
          }}
          onMouseOut={() => {
            setHovered(false)
          }}
          onMouseUp={() => {
            props.context.ui.dialog.clear()
          }}
        >
          {copy().drops.closeLabel}
        </text>
      </box>

      <Show
        when={drops().length > 0}
        fallback={
          <box flexDirection="column" gap={1}>
            <text fg={theme.text.muted}>{copy().drops.empty}</text>
            <text fg={theme.text.muted}>{copy().drops.footer}</text>
          </box>
        }
      >
        <box flexDirection="row" height={1}>
          <For each={[...drops()].reverse()}>
            {(drop) => <text fg={barColor(drop.dropPp, theme)}>{barGlyph(drop.dropPp)}</text>}
          </For>
          <text fg={theme.text.muted}>{`  ${copy().drops.spark}`}</text>
        </box>

        <scrollbox height={listHeight()} scrollY={true} width="100%" flexShrink={0}>
          <For each={drops()}>
            {(drop) => {
              const isActive = () => active()?.messageID === drop.messageID
              const select = (): void => {
                setSelected(drop.messageID)
              }
              return (
                <box
                  flexDirection="row"
                  height={1}
                  gap={1}
                  backgroundColor={isActive() ? theme.background.raised.high : theme.background.base}
                  onMouseDown={select}
                >
                  <text
                    fg={isActive() ? theme.text.feedback.success.base : theme.text.muted}
                    selectable={false}
                    onMouseDown={select}
                  >
                    {isActive() ? "▶" : " "}
                  </text>
                  <text fg={theme.text.muted} selectable={false} onMouseDown={select}>
                    {timeLabel(drop.at)}
                  </text>
                  <text fg={barColor(drop.dropPp, theme)} selectable={false} onMouseDown={select}>
                    {`-${drop.dropPp.toFixed(1)}pp`}
                  </text>
                  <text fg={theme.text.muted} selectable={false} onMouseDown={select}>
                    {copy().drops.kind[drop.kind ?? "unknown"]}
                  </text>
                  <text fg={theme.text.muted} selectable={false} onMouseDown={select}>
                    {copy().drops.causeIcon[drop.cause]}
                  </text>
                  <text fg={theme.text.base} flexGrow={1} wrapMode="none" selectable={false} onMouseDown={select}>
                    {segmentLabel(drop.breakPoint)}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>

        <Show when={active()}>
          {(drop) => (
            <scrollbox height={detailHeight()} scrollY={true} focused={true} width="100%" flexShrink={0}>
              <DropDetail
                context={props.context}
                sessionID={props.sessionID}
                theme={theme}
                copy={copy()}
                drop={drop()}
                onOpenCompare={() => {
                  setComparing(true)
                }}
                onOpenNode={(node, path) => {
                  setNodeView({ node, path, body: drop().bodies?.body })
                }}
              />
            </scrollbox>
          )}
        </Show>

        <text fg={theme.text.muted}>{copy().drops.footer}</text>
      </Show>
      </Show>
    </box>
  )
}

/**
 * 输入：单条记录 + 文案。
 * 输出：命中率对比、断点两侧差异、请求结构、断点段原文。
 * 预期：只展示实测事实；没有断点时明确说明没有可对照的报文。
 */
function DropDetail(props: {
  readonly context: Context
  readonly sessionID: string
  readonly theme: Context["theme"]
  readonly copy: ReturnType<typeof resolveMessages>
  readonly drop: CacheDrop
  readonly onOpenCompare: () => void
  readonly onOpenNode: (node: CacheDropNode, path: readonly string[]) => void
}) {
  const outline = createMemo(() => props.drop.outline ?? [])
  const groups = createMemo(() => groupOutline(outline()))
  const tree = createMemo(() => props.drop.tree ?? [])
  const [treeOpen, setTreeOpen] = createSignal(false)
  const [openPaths, setOpenPaths] = createSignal<ReadonlySet<string>>(new Set())
  const [openGroups, setOpenGroups] = createSignal<ReadonlySet<string>>(new Set())

  /** 输入：节点路径；输出：无；预期：单独展开/收起这一节点。 */
  const togglePath = (path: string): void => {
    setOpenPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /** 输入：字段名；输出：无；预期：旧记录回退树里单独展开/收起这一层。 */
  const toggleGroup = (name: string): void => {
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  /** 输入：叶子节点 + 它在记录树里的键路径；输出：无；预期：切到节点内容层看完整值。 */
  const openNode = (node: CacheDropNode, path: readonly string[]): void => {
    props.onOpenNode(node, path)
  }

  const excerpt = createMemo(() => {
    const point = props.drop.breakPoint
    if (point === undefined) return undefined
    return splitExcerpt(point)
  })

  return (
    <box flexDirection="column" width="100%" gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={props.theme.text.base}>
          <b>{props.copy.drops.kind[props.drop.kind ?? "unknown"]}</b>
        </text>
        <text fg={props.theme.text.muted}>{`${props.copy.drops.causeIcon[props.drop.cause]} ${props.copy.drops.cause[props.drop.cause]}`}</text>
        <text fg={props.theme.text.muted}>{segmentLabel(props.drop.breakPoint)}</text>
        <Show when={props.drop.model}>
          {(model) => <text fg={props.theme.text.muted}>{model()}</text>}
        </Show>
      </box>

      <box flexDirection="row" gap={1} flexWrap="wrap">
        <text fg={props.theme.text.muted}>{props.copy.drops.prev}</text>
        <text fg={props.theme.text.base}>{formatTokens(props.drop.prevPrompt)}</text>
        <text fg={props.theme.text.feedback.success.base}>{`${formatHitRate(props.drop.prevHitRate)}%`}</text>
        <text fg={props.theme.text.muted}>{"→"}</text>
        <text fg={props.theme.text.muted}>{props.copy.drops.cur}</text>
        <text fg={props.theme.text.base}>{formatTokens(props.drop.prompt)}</text>
        <text fg={props.theme.text.feedback.error.base}>{`${formatHitRate(props.drop.hitRate)}%`}</text>
        <text fg={props.theme.text.feedback.error.base}>{`-${props.drop.dropPp.toFixed(1)}pp`}</text>
      </box>

      <Show when={excerpt()}>
        {(split) => (
          <box flexDirection="column" width="100%">
            <text fg={props.theme.text.muted} wrapMode="word">{`${props.copy.drops.break} ${segmentLabel(props.drop.breakPoint)}`}</text>
            <Show when={split().prefix.length > 0}>
              <text fg={props.theme.text.feedback.success.base} wrapMode="word">{`…${split().prefix}`}</text>
            </Show>
            <DiffLine sign="-" text={split().was} color={props.theme.text.feedback.error.base} />
            <DiffLine sign="+" text={split().now} color={props.theme.text.feedback.error.base} />
            <Show when={split().suffix.length > 0}>
              <text fg={props.theme.text.feedback.success.base} wrapMode="word">{`${split().suffix}…`}</text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={props.drop.appended}>
        {(tail) => (
          <box flexDirection="column" width="100%">
            <box flexDirection="row" gap={1} flexWrap="wrap">
              <text fg={props.theme.text.muted}>{props.copy.drops.appended}</text>
              <text fg={props.theme.text.base}>{segmentLabel(tail())}</text>
            </box>
            <DiffLine sign="+" text={tail().after} color={props.theme.text.feedback.success.base} />
          </box>
        )}
      </Show>
      <Show when={props.drop.breakPoint === undefined && props.drop.appended === undefined}>
        <text fg={props.theme.text.muted}>{props.copy.drops.noBreak}</text>
      </Show>

      <box
        flexDirection="row"
        height={1}
        gap={1}
        onMouseDown={() => {
          props.onOpenCompare()
        }}
      >
        <text fg={props.theme.text.feedback.info.base} flexShrink={0} selectable={false}>
          {"›"}
        </text>
        <text fg={props.theme.text.base} selectable={false}>
          {props.copy.drops.openCompare}
        </text>
      </box>

      <Show when={groups().length > 0 || tree().length > 0}>
        <box flexDirection="column" width="100%">
          <box
            flexDirection="row"
            height={1}
            gap={1}
            onMouseDown={() => {
              setTreeOpen(!treeOpen())
            }}
          >
            <text fg={props.theme.text.base} selectable={false}>
              {treeOpen() ? "▼" : "▶"}
            </text>
            <text fg={props.theme.text.muted} selectable={false}>
              {props.copy.drops.structure}
            </text>
          </box>
          <Show when={treeOpen()}>
            <box flexDirection="column" width="100%" flexShrink={0}>
            <Show
              when={tree().length > 0}
              fallback={
                <For each={groups()}>
                  {(group) => (
                    <box flexDirection="column" width="100%" paddingLeft={2} flexShrink={0}>
                      <Show
                        when={group.array}
                        fallback={
                          <text fg={props.theme.text.base} wrapMode="none">
                            {`${group.name} ${props.copy.drops.chars((group.leaves[0]?.chars ?? 0).toLocaleString())}`}
                          </text>
                        }
                      >
                        <box
                          flexDirection="row"
                          height={1}
                          gap={1}
                          flexShrink={0}
                          onMouseDown={() => {
                            toggleGroup(group.name)
                          }}
                        >
                          <text fg={props.theme.text.base} selectable={false}>
                            {openGroups().has(group.name) ? "▼" : "▶"}
                          </text>
                          <text fg={props.theme.text.base} wrapMode="none" selectable={false}>{`${group.name} (${group.leaves.length.toString()})`}</text>
                        </box>
                        <Show when={openGroups().has(group.name)}>
                          <scrollbox
                            height={Math.min(10, group.leaves.length)}
                            width="100%"
                            scrollY={true}
                            flexShrink={0}
                          >
                            <For each={group.leaves}>
                              {(leaf) => (
                                <box paddingLeft={2} flexShrink={0}>
                                  <text fg={props.theme.text.muted} wrapMode="none">
                                    {`${leaf.label} ${props.copy.drops.chars(leaf.chars.toLocaleString())}`}
                                  </text>
                                </box>
                              )}
                            </For>
                          </scrollbox>
                        </Show>
                      </Show>
                    </box>
                  )}
                </For>
              }
            >
              <For each={tree()}>
                {(node) => (
                  <TreeNode
                    node={node}
                    path={[node.key]}
                    depth={1}
                    open={openPaths}
                    toggle={togglePath}
                    onOpen={openNode}
                    theme={props.theme}
                    copy={props.copy}
                  />
                )}
              </For>
            </Show>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

/**
 * 输入：结构节点 + 深度 + 路径 + 展开集合。
 * 输出：按 JSON 层级缩进的一行；有子节点的行可点击逐层展开。
 * 预期：默认全部收起；子节点比父节点多缩进两格。
 */
function TreeNode(props: {
  readonly node: CacheDropNode
  readonly path: readonly string[]
  readonly depth: number
  readonly open: Accessor<ReadonlySet<string>>
  readonly toggle: (path: string) => void
  readonly onOpen: (node: CacheDropNode, path: readonly string[]) => void
  readonly theme: Context["theme"]
  readonly copy: ReturnType<typeof resolveMessages>
}) {
  const key = () => props.path.join("/")
  const children = () => props.node.children ?? []
  const opened = () => props.open().has(key())
  const hasChildren = () => children().length > 0
  const [hovered, setHovered] = createSignal(false)
  // 子元素（箭头/数量）按下时先置位，行处理器看到后只展开、不打开内容。
  let suppressOpen = false
  /** 输入：无；输出：无；预期：本次点击只展开，不触发内容视图。 */
  const toggleOnly = (): void => {
    suppressOpen = true
    props.toggle(key())
    setTimeout(() => {
      suppressOpen = false
    }, 0)
  }
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <box
        flexDirection="row"
        height={1}
        gap={1}
        flexShrink={0}
        paddingLeft={props.depth * 2}
        backgroundColor={hovered() ? props.theme.background.raised.high : props.theme.background.base}
        onMouseOver={() => {
          setHovered(true)
        }}
        onMouseOut={() => {
          setHovered(false)
        }}
        onMouseDown={() => {
          setHovered(false)
          if (suppressOpen) {
            suppressOpen = false
            return
          }
          if (hasChildren()) {
            props.toggle(key())
            return
          }
          props.onOpen(props.node, props.path)
        }}
      >
        <box
          height={1}
          width={1}
          flexShrink={0}
          onMouseDown={() => {
            if (!hasChildren()) return
            toggleOnly()
          }}
        >
          <text fg={props.theme.text.base} selectable={false}>
            {hasChildren() ? (opened() ? "▼" : "▶") : " "}
          </text>
        </box>
        <text
          fg={hovered() ? props.theme.text.feedback.info.base : props.theme.text.base}
          wrapMode="none"
          selectable={false}
        >
          {props.node.key}
        </text>
        <Show
          when={hasChildren()}
          fallback={
            <text fg={props.theme.text.muted} wrapMode="none" selectable={false}>
              {props.copy.drops.chars(props.node.chars.toLocaleString())}
            </text>
          }
        >
          <box
            height={1}
            flexShrink={0}
            onMouseDown={() => {
              toggleOnly()
            }}
          >
            <text fg={props.theme.text.muted} selectable={false}>
              {`(${children().length.toString()})`}
            </text>
          </box>
        </Show>
      </box>
      <Show when={opened()}>
        <Show
          when={props.depth === 1 && children().length > 10}
          fallback={
            <For each={children()}>
              {(child) => (
                <TreeNode
                  node={child}
                  path={[...props.path, child.key]}
                  depth={props.depth + 1}
                  open={props.open}
                  toggle={props.toggle}
                  onOpen={props.onOpen}
                  theme={props.theme}
                  copy={props.copy}
                />
              )}
            </For>
          }
        >
          <scrollbox height={10} width="100%" scrollY={true} flexShrink={0}>
            <For each={children()}>
              {(child) => (
                <TreeNode
                  node={child}
                  path={[...props.path, child.key]}
                  depth={props.depth + 1}
                  open={props.open}
                  toggle={props.toggle}
                  onOpen={props.onOpen}
                  theme={props.theme}
                  copy={props.copy}
                />
              )}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  )
}

/**
 * 输入：被点开的叶子节点 + 文案 + 键路径 + 内联完整报文。
 * 输出：可滚动的原始内容弹窗；完整值从内联报文按路径取，拿不到时退回记录里的截断原文。
 * 预期：JSON 两空格缩进，超宽行靠横向滚动；横竖都能滚，不撑开主界面。
 */
export function NodeTextDialog(props: {
  readonly context: Context
  readonly copy: ReturnType<typeof resolveMessages>
  readonly node: CacheDropNode
  readonly path: readonly string[]
  readonly body: string | undefined
  readonly onBack: () => void
}) {
  const theme = props.context.theme
  const [hovered, setHovered] = createSignal(false)
  const lines = createMemo(() => {
    const body = props.body
    if (body !== undefined) {
      try {
        const found = valueAtPath(JSON.parse(body) as unknown, props.path)
        if (found.ok && found.value !== undefined) return prettyJsonLines(JSON.stringify(found.value))
      } catch {
        // 解析失败时退回截断原文
      }
    }
    return prettyJsonLines(props.node.text)
  })
  const width = createMemo(() => {
    let max = 24
    for (const line of lines()) {
      const size = Array.from(line).length
      if (size > max) max = size
    }
    return Math.min(2_000, max + 1)
  })
  const height = createMemo(() => {
    const size = props.context.renderer.height
    return Math.max(8, Math.min(26, (Number.isFinite(size) && size > 0 ? size : 40) - 8))
  })
  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme.text.base} wrapMode="word">
          <b>{`${props.copy.drops.nodeTitle} ${props.path.join("/")}`}</b>
        </text>
        <text
          fg={hovered() ? theme.text.feedback.error.base : theme.text.muted}
          flexShrink={0}
          onMouseOver={() => {
            setHovered(true)
          }}
          onMouseOut={() => {
            setHovered(false)
          }}
          onMouseUp={() => {
            props.onBack()
          }}
        >
          {props.copy.drops.closeLabel}
        </text>
      </box>
      <text fg={theme.text.muted}>
        {props.node.truncated === true
          ? `${props.copy.drops.chars(props.node.chars.toLocaleString())} · ${props.copy.drops.truncated}`
          : props.copy.drops.chars(props.node.chars.toLocaleString())}
      </text>
      <scrollbox height={height()} scrollX={true} scrollY={true} focused={true} width="100%">
        <For each={lines()}>
          {(line) => (
            <text fg={theme.text.base} width={width()} flexShrink={0} wrapMode="none">
              {line.length === 0 ? " " : line}
            </text>
          )}
        </For>
      </scrollbox>
    </box>
  )
}
