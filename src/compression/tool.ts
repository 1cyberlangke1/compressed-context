import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { diagnostic, diagnosticResult, type Diagnostic } from "../shared/diagnostic.ts"
import { resolveSummaryLimits, type SummaryFormat } from "../shared/settings.ts"
import { babelShapeDiagnostic } from "./babel.ts"
import { createT1Block } from "./block.ts"
import { endCompactionRequest, tryBeginCompactionRequest } from "./inflight.ts"
import { toSummary } from "./normalize.ts"
import { summaryInputFor } from "./schema.ts"
import { loadServerSettings, readStoredWindow } from "./settings.ts"
import { eligibleMessages, messageRange, type MessageLike } from "./select.ts"
import { sessionMessagesToMessageLikes } from "./session-message.ts"
import { isSubagentSession } from "./session-role.ts"
import { summaryShape } from "./shape.ts"
import { loadState, withPending, type Block } from "./state.ts"
import { stateStore } from "./state-store.ts"
import type { Disposable } from "./settings-rpc.ts"
import { buildTranscript } from "./transcript.ts"
import { saveTranscript } from "./transcript-store.ts"
import { MIN_SOURCE_CHARS, validateSummary } from "./validate.ts"

const COMMON =
  "Compress the conversation so far into a structured checkpoint. Call this when the context is getting full. " +
  "It covers every message since the last compressed block, up to the current user message, and replaces them with one block. " +
  "Do not call while a compression is already pending. Add a short title if useful."

/** 输入：摘要格式；输出：该格式专用的内容记录与保真指引。 */
function contentGuidelines(format: SummaryFormat): string {
  if (format === "babel") {
    return (
      "Lossless facts in pure symbolic Babel: F[path:line], Config[k=v], signatures, exact values. " +
      "Decisions: logical causality (D[target]: cause=>effect or ¬bad & good). Failures: (!target: err=>action). " +
      "Open objectives: keep still-open work as ⏳[target]: <goal> (?=> <next>); carry forward verbatim across tiers. " +
      "Leverage Emoji (✅ pass, ❌ fail, ⚠️ pitfall, ⏳ pending, 🎯 target, 📦 release, ♻ cache) and logic symbols (=>, ¬, &, |, ->, ?=>). " +
      "Strictly forbid natural language clauses inside brackets. Zero prose/sentences. " +
      "Describe past as settled history (✅), not active directives to re-execute. Omit logs and settled exploration."
    )
  }
  return (
    "The block is the only remaining record of those messages, so copy exact paths with line numbers, signatures, the " +
    "code lines that carry the logic, error text, versions, config keys, thresholds, and measured values. " +
    "Give the reason for each decision, keep the objective and any pivots, why important actions were taken, unanswered " +
    "questions, and work the user still expects. Carry forward still-open user objectives (e.g. Open objectives: ...). " +
    "Describe the past as settled history, never as live directives to re-execute. " +
    "Leave out logs, repeated reads, exploration that produced nothing, abandoned attempts (one line on why), and " +
    "repeated status checks. If space is tight, keep objective and constraints first, then decisions and reasons, then " +
    "exact technical facts, then conclusions, then lessons. Write short factual entries, not prose."
  )
}

/** 输入：无；输出：compress 工具输出；预期：成功带 block，失败带 error 与编译器式诊断字段，任何情况都不返回空壳。 */
const CompressOutput = Schema.Struct({
  block: Schema.optional(Schema.String),
  status: Schema.String,
  error: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  at: Schema.optional(Schema.String),
  expected: Schema.optional(Schema.String),
  got: Schema.optional(Schema.String),
  excerpt: Schema.optional(Schema.String),
  fix: Schema.optional(Schema.String),
})

/**
 * 输入：摘要格式。
 * 输出：该格式的字段使用规则。
 * 预期：只讲这个格式用得上的字段，不把三种格式混在一起讲。
 */
function fieldRules(format: SummaryFormat): string {
  if (format === "babel") {
    return (
      "Only `T=<short title>|G=<one-line goal>` is fixed; the body is a dense symbolic index using anchors, Emoji, and " +
      "logic symbols for maximum token efficiency. Keep shipped work and still-open work in that body, and never invent facts."
    )
  }
  if (format === "markdown") {
    return (
      "Only include sections with real content; never invent entries to fill one. " +
      "Use real file paths in `## Files`; put config keys and function names in `## Facts`. " +
      "Put work in `### Completed` only when it was actually finished; plans go in `### Active` or `## Open Items`."
    )
  }
  return (
    "Omit any optional field that has no real content instead of inventing entries. " +
    "Use `files` only for real file paths; put config keys and function names in `facts`. " +
    "Put work in `progress.completed` only when it was actually finished; plans go in `progress.active` or `open_items`."
  )
}

/** 输入：摘要格式；输出：compress 工具描述；写法部分与压缩提示词共用同一份文案。 */
export function descriptionFor(format: SummaryFormat): string {
  return [COMMON, summaryShape(format), fieldRules(format), contentGuidelines(format)].join("\n\n")
}

/** 输入：错误码 + 核心一句摘要 + 可选精确字段；输出：诊断数据。 */
type FailureCode =
  | "SUBAGENT_DENIED"
  | "ALREADY_IN_PROGRESS"
  | "CONTEXT_READ_FAILED"
  | "NOTHING_TO_COMPRESS"
  | "SOURCE_TOO_SMALL"
  | "TOOL_DISABLED"
  | "INVALID_SUMMARY"
  | "VALIDATION_FAILED"
  | "MESSAGE_IDS_MISSING"
  | "COMPACT_START_FAILED"

/** 输入：精确字段（可选键不落成显式 undefined）。 */
interface FailureExtra {
  readonly at?: string
  readonly expected?: string
  readonly got?: string
  readonly excerpt?: string
  readonly fix?: string
}

/**
 * 输入：语义错误码、核心摘要（等于旧文案，供 output.error 兼容既有断言）、可选精确字段。
 * 输出：compress 工具的失败返回体。
 * 预期：编译器式诊断走 diagnosticResult 单点渲染；工具层不再自己拼 `ERROR:` 文案。
 */
function failure(code: FailureCode, summary: string, extra?: FailureExtra) {
  return diagnosticResult(diagnostic({ tool: "compress", code, summary, ...(extra ?? {}) }), { status: "error" })
}

/** 输入：解析层产出的完整诊断；输出：compress 失败返回体。预期：保留其 at/expected/got/excerpt/fix。 */
function fromDiagnostic(d: Diagnostic) {
  return diagnosticResult(d, { status: "error" })
}

/** compress 工具的注册句柄：注销 + 切换摘要格式。 */
export interface CompressToolHandle extends Disposable {
  /** 输入：新的摘要格式；输出：无；预期：更新工具描述与参数，并让宿主重算工具列表。 */
  setFormat(format: SummaryFormat): Promise<void>
}

/**
 * 输入：服务端上下文。
 * 输出：注册 compress 工具，并返回可切换格式的句柄。
 * 预期：执行时从会话上下文按需取消息，不再把整段历史常驻内存；
 *      描述与参数按当前摘要格式生成，切换后由宿主重新计算工具列表。
 */
export async function registerCompressTool(
  ctx: Plugin.Context,
  legacyCache?: ReadonlyMap<string, readonly MessageLike[]>,
): Promise<CompressToolHandle> {
  const initial = await loadServerSettings(ctx)
  let format: SummaryFormat = initial.summaryFormat
  const registration = await ctx.tool.transform((tools) => {
    tools.add({
      name: "compress",
      options: { codemode: false },
      description: descriptionFor(format),
      input: summaryInputFor(format),
      output: CompressOutput,
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        // 第二道防线：context 钩子已经对子代理隐藏工具，这里再挡一次直接调用。
        if (await isSubagentSession(ctx, sessionID)) {
          return failure("SUBAGENT_DENIED", "compress is unavailable in subagent sessions", {
            expected: "a top-level session",
            got: "a subagent session (parentID set)",
            fix: "call compress from the main session, not from a subagent",
          })
        }
        // 与自动压缩共用同一个进程级发起锁：手动和自动只能有一个真正调用 session.compact。
        // 抢不到时直接失败，不能等锁；否则同一会话会并发入队两次压缩。
        if (!tryBeginCompactionRequest(sessionID)) {
          return failure("ALREADY_IN_PROGRESS", "compression already in progress", {
            expected: "no in-flight compaction",
            got: "another compaction holds the request lock",
            fix: "wait for the current compaction, then call compress again",
          })
        }
        try {
          const state = await loadState(ctx.storage, sessionID)
          if (state.pending || state.phase !== undefined) {
            return failure("ALREADY_IN_PROGRESS", "compression already in progress", {
              expected: "no pending block and no merge phase",
              got: state.pending === undefined ? `phase=${String(state.phase)}` : `pending=${state.pending.id}`,
              fix: "wait for the pending compaction to settle, then call compress again",
            })
          }

          let eligible: readonly MessageLike[] | undefined
          try {
            const raw = await ctx.session.context({ sessionID })
            eligible = eligibleMessages(sessionMessagesToMessageLikes(raw))
          } catch {
            // 兼容旧测试替身；生产路径不传 legacyCache。
            eligible = legacyCache === undefined ? undefined : (legacyCache.get(sessionID) ?? [])
          }
          if (eligible === undefined) {
            return failure("CONTEXT_READ_FAILED", "failed to read session context", {
              at: "ctx.session.context({ sessionID })",
              expected: "the current session message list",
              got: "undefined (read threw)",
              fix: "retry the tool call; if it keeps failing, check the session still exists",
            })
          }
          const transcript = buildTranscript(eligible)
          const sourceChars = transcript.length
          if (eligible.length === 0) {
            return failure("NOTHING_TO_COMPRESS", "nothing to compress", {
              expected: "at least one compressible message",
              got: "0 eligible messages",
              fix: "wait for new conversation content, then call compress again",
            })
          }
          if (sourceChars < MIN_SOURCE_CHARS) {
            return failure(
              "SOURCE_TOO_SMALL",
              `not enough content to compress (${sourceChars.toString()} chars, min ${MIN_SOURCE_CHARS.toString()})`,
              {
                at: "session.messages",
                expected: `>= ${MIN_SOURCE_CHARS.toString()} chars of source`,
                got: `${sourceChars.toString()} chars`,
                fix: "wait for more conversation, or lower the threshold in settings",
              },
            )
          }

          const settings = await loadServerSettings(ctx)
          if (!settings.enableCompressTool) {
            return failure("TOOL_DISABLED", "compress tool is disabled in settings", {
              expected: "enableCompressTool=true",
              got: "enableCompressTool=false",
              fix: "turn the compress tool on in settings, then call again",
            })
          }
          // 优先用当前会话模型自己的窗口；取不到再回退最近一次解析值。
          const windowTokens = await readStoredWindow(ctx, sessionID)
          const limits = resolveSummaryLimits(settings, windowTokens)
          const summary = toSummary(input, settings.summaryFormat)
          if (summary === undefined) {
            const shape = babelShapeDiagnostic(input, settings.summaryFormat)
            return shape === undefined
              ? failure("INVALID_SUMMARY", "invalid summary shape", {
                  at: `input.${settings.summaryFormat}`,
                  expected: "a well-formed summary",
                  got: JSON.stringify(input).slice(0, 120),
                  fix: "check the tool argument shape for the active summary format",
                })
              : fromDiagnostic(shape)
          }
          const validation = validateSummary(summary, sourceChars, undefined, limits.blockChars)
          if (!validation.ok) {
            return failure("VALIDATION_FAILED", validation.message, {
              at: validation.fields.join(", ") || "summary",
              expected: `non-empty fields and length within [${MIN_SOURCE_CHARS.toString()}, ${limits.blockChars.toString()}]`,
              got: validation.message,
              fix: `fix the flagged fields (${validation.fields.join(", ") || "summary"}) and call compress again`,
            })
          }

          const range = messageRange(eligible)
          if (range === undefined) {
            return failure("MESSAGE_IDS_MISSING", "messages are missing ids", {
              expected: "every eligible message has an id",
              got: "at least one message without an id",
              fix: "retry; if it persists the session context is corrupted",
            })
          }

          // 长耗时的摘要校验在锁外完成；落 pending 时重新检查状态并用最新 blocks 生成 id。
          type SaveOutcome = { readonly error: string } | { readonly block: Block }
          const saved = await stateStore(ctx.storage).transact<SaveOutcome>(sessionID, (fresh) => {
            if (fresh.pending !== undefined || fresh.phase !== undefined) {
              return { result: { error: "compression already in progress" } }
            }
            const block = createT1Block({
              blocks: fresh.blocks,
              summary,
              fromId: range.fromId,
              toId: range.toId,
              sourceChars,
            })
            return { next: withPending(fresh, block), result: { block } }
          })
          if ("error" in saved) {
            return failure("ALREADY_IN_PROGRESS", saved.error, {
              expected: "no concurrent state change",
              got: saved.error,
              fix: "wait for the current compaction, then call compress again",
            })
          }
          const block = saved.block

          // transcript 落盘失败不应阻断摘要；解压时会降级为占位符。
          // 先落 pending 再写 transcript：summary 生成前 transcript 一定已经写完。
          try {
            await saveTranscript(ctx.storage, sessionID, block, eligible)
          } catch {
            // best effort
          }

          try {
            await ctx.session.compact({ sessionID })
          } catch (error) {
            await stateStore(ctx.storage).transact(sessionID, (fresh) => ({
              next: { ...fresh, lastError: String(error) },
              result: undefined,
            }))
            return failure("COMPACT_START_FAILED", `failed to start compaction: ${String(error)}`, {
              at: "ctx.session.compact({ sessionID })",
              expected: "compaction request accepted",
              got: String(error),
              fix: "retry; if it persists check that the session is still active",
            })
          }

          return {
            output: { block: block.id, status: "queued" },
            content: `queued compression ${block.id}`,
          }
        } finally {
          // 成功、校验失败、读上下文失败、compact 抛错都必须释放，否则同一会话后续压缩永久被拒。
          endCompactionRequest(sessionID)
        }
      },
    })
  })
  return {
    dispose: () => registration.dispose(),
    setFormat: async (next) => {
      format = next
      await ctx.tool.reload()
    },
  }
}
