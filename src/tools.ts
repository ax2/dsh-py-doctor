/**
 * DSH tool definitions. Each tool is a thin, declarative binding: a parameter
 * schema for the model, a pure parser call, and the shared receipt renderer.
 *
 * None of these tools executes Python, reads a file, touches the network, or
 * consults a clock. They are total functions from pasted report text to a
 * structured diagnosis, and every one of them reports what it could not read.
 * @module dsh-py-doctor/tools
 */
import {
  defineTool,
  parameterSchemaSpecToJsonSchema,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { renderEnvelope, type Envelope } from './core/receipt.ts'
import { assertWithinInput, clipItems, utf8Bytes } from './core/bytes.ts'
import { coverageNote, type CoverageSummary } from './core/coverage.ts'
import { parsePythonTraceback, type TracebackReport } from './core/traceback.ts'
import { parsePytestSummary, type PytestReport } from './core/pytest.ts'
import { parseDjangoMigrations, type MigrationsReport } from './core/migrations.ts'
import { analyzeSqlLog, type SqlReport } from './core/sql.ts'
import { parseDjangoChecks, type ChecksReport } from './core/checks.ts'
import { parseCeleryReport, type CeleryReport } from './core/celery.ts'
import type { Limits } from './limits.ts'

/** Tool groups, used by the `only` config filter and documentation. */
export type ToolGroup = 'python'

/** Shared meta schema for the receipt envelope. */
const META_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bytesIn: { type: 'integer', required: true, description: 'UTF-8 bytes read from the primary input.' },
    bytesOut: { type: 'integer', required: true, description: 'UTF-8 bytes of the canonical result.' },
    truncated: { type: 'boolean', required: true, description: 'True when a configured budget clipped input or output.' },
    notes: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered notes: budgets, absent sections, unparsed syntax.' },
  },
} as const

/**
 * Result schema slot.
 *
 * Every parser reports its own coverage and parser revision inside a nested
 * `coverage` object, so the declared result is intentionally the lossless-JSON
 * node rather than a hand-maintained mirror of six TS interfaces; the shapes are
 * pinned by tests and by the TSDoc on each core parser instead.
 */
const RESULT_SPEC = { type: 'json' } as const

/** One tool body: model-facing schema plus a bounded, synchronous implementation. */
export interface ToolBody {
  /** Tool name as the model sees it. */
  name: string
  /** Model-facing description; states the bounds and what the tool refuses. */
  description: string
  /** Parameter schema. */
  parameters: ParameterSchemaSpec
  /** Canonical result schema for the `result` field. */
  result: ValueSchemaSpec
  /** Group used by the `only` filter. */
  group: ToolGroup
  /** Implementation receiving validated arguments and the effective budgets. */
  run(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue>
}

/**
 * Build a registry-ready definition with the shared receipt renderer.
 *
 * The registry validates the canonical value against the declared per-tool
 * `result` schema; only the author-facing generic is erased, because
 * `InferValue` collapses over a broad `ValueSchemaSpec` union. The pairing is
 * asserted by the tool tests instead.
 * @param body - tool body.
 * @param opts - budgets, name prefix, and allowlist for this plugin instance.
 */
export function defineReceiptTool(body: ToolBody, opts: ToolFactoryOptions) {
  const { limits, prefix = '' } = opts
  if (opts.only !== undefined && opts.only.length > 0 && !opts.only.includes(body.name)) return undefined
  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { result: body.result ?? RESULT_SPEC, meta: META_SPEC },
  } as const
  const options = {
    name: prefix.length > 0 ? `${prefix}__${body.name}` : body.name,
    description: body.description,
    parameters: body.parameters,
    output: {
      schema: outputSchema,
      render: (_args: unknown, value: Envelope<unknown>) => renderEnvelope(value),
    },
    async execute(args: unknown, exec: { signal: AbortSignal }) {
      exec.signal.throwIfAborted()
      return guardOutputSize(body.run(args as Record<string, unknown>, limits), limits)
    },
  }
  // `defineTool`'s const generics recurse through `InferObject` over the broad
  // `ParameterSchemaSpec` union; the schema is still compiled and checked below,
  // so only the erased generic is dropped here.
  const compile = defineTool as unknown as (input: unknown) => ToolDefinition
  return compile(options)
}

/**
 * Backstop for the declared output budget.
 *
 * Each parser bounds its own result through per-family list caps, so this only
 * fires when a configuration raised those caps past `maxOutputBytes`. A
 * structured payload cannot be partially clipped without becoming a different
 * value, so it is returned whole and marked instead of being silently mangled.
 * @param value - envelope produced by a tool body.
 * @param limits - effective budgets.
 */
function guardOutputSize(value: Envelope<unknown>, limits: Limits): Envelope<unknown> {
  const size = utf8Bytes(JSON.stringify(value.result ?? null) ?? '')
  if (size <= limits.maxOutputBytes) return value
  return {
    result: value.result,
    meta: {
      ...value.meta,
      truncated: true,
      notes: [
        ...value.meta.notes,
        `result payload is ${size} bytes, above maxOutputBytes=${limits.maxOutputBytes}; it was returned whole because a canonical value cannot be partially clipped`,
      ],
    },
  }
}

/** Compile a parameter schema to JSON Schema, proving the DSL node is valid. */
export function compileParameters(spec: ParameterSchemaSpec) {
  return parameterSchemaSpecToJsonSchema(spec)
}

const TEXT_INPUT = {
  type: 'string',
  required: true,
  description: 'Report text, pasted inline. No file path is accepted: the tool never reads the filesystem.',
} as const

/** Options shared by every tool built for one plugin instance. */
export interface ToolFactoryOptions {
  /** Effective budgets. */
  limits: Limits
  /** Optional tool-name prefix, joined with `__`. */
  prefix?: string
  /** Register only these base tool names; empty registers every tool. */
  only?: readonly string[]
}

/**
 * Every tool this package registers, in registration order.
 * @param opts - budgets, name prefix, and optional allowlist.
 */
export function createTools(opts: ToolFactoryOptions) {
  const tools: (ReturnType<typeof defineReceiptTool>)[] = [
    defineReceiptTool(
      {
        name: 'python_traceback',
        group: 'python',
        description:
          'Parse a CPython traceback into its exception type and message, frame chain, chained exceptions, SyntaxError caret offsets, ' +
          'elided recursion loops, and installed-package versus project frames, plus root-cause hints for the common Django and Python ' +
          'exception types. Refuses (with an explicit error) any input above maxInputBytes instead of partially parsing it, never runs ' +
          'Python, never reads a file, and never contacts the network; text it cannot attribute to the traceback grammar is reported in ' +
          '`coverage.unknown_lines` with a reduced `coverage.confidence`, never dropped.',
        parameters: { text: TEXT_INPUT },
        result: RESULT_SPEC,
        run: (args, limits) => runTraceback(args, limits),
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'pytest_summary',
        group: 'python',
        description:
          'Parse `pytest -q` / `-ra` / short-summary output into passed/failed/errors/skipped/xfailed/xpassed/warnings/deselected counts, ' +
          'the duration, the failure and error list with file:line and the `E ` assertion excerpt, the `short test summary info` entries, ' +
          'and the slowest tests when `--durations` was printed. Sections the invocation did not print are named in `warnings` rather than ' +
          'guessed at; input above maxInputBytes is refused outright, and nothing is ever executed.',
        parameters: { text: TEXT_INPUT },
        result: RESULT_SPEC,
        run: (args, limits) => runPytest(args, limits),
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'django_migrations',
        group: 'python',
        description:
          'Parse `python manage.py showmigrations` (default indented list, `--plan` flat list, and `--database` banners) into per-app applied ' +
          'and unapplied migration names with counts, the apps that still need a plan, the apps that printed `(no migrations)`, the totals, ' +
          'and a `plan_needed` boolean. Refuses over-budget input instead of truncating it; unrelated command output is either recognized as ' +
          'a banner or surfaced through the coverage receipt.',
        parameters: { text: TEXT_INPUT },
        result: RESULT_SPEC,
        run: (args, limits) => runMigrations(args, limits),
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'django_sql_n_plus_one',
        group: 'python',
        description:
          'Group repeated SQL text (a `connection.queries` dump, a django-debug-toolbar SQL panel, or `-v2` query log lines) by normalized ' +
          'form — whitespace collapsed, string literals, numbers, `%s`/`?` placeholders and parameter lists replaced with `?` — and report ' +
          'N+1 candidates: every statement repeated at least `min_repeats` times (default 3), with its count, verb, tables and one original ' +
          'example. Normalization is lossy by design and can merge statements that differ only by a constant, so the example is always kept; ' +
          'over-budget input is refused and no query is ever sent to a database.',
        parameters: {
          text: TEXT_INPUT,
          min_repeats: {
            type: 'integer',
            description: 'Repetition count at which a normalized statement becomes an N+1 candidate (default 3, minimum 2).',
          },
        },
        result: RESULT_SPEC,
        run: (args, limits) => runSql(args, limits),
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'django_checks',
        group: 'python',
        description:
          'Parse `manage.py check` / `check --deploy` output into one finding per issue with its level, diagnostic id, message, hint and ' +
          'best-effort object, the counts per severity, the deployment-checklist items, and the `System check identified ...` summary. ' +
          'Refuses over-budget input, never invokes Django, and reports a summary/finding count mismatch instead of silently trusting either side.',
        parameters: { text: TEXT_INPUT },
        result: RESULT_SPEC,
        run: (args, limits) => runChecks(args, limits),
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'celery_report',
        group: 'python',
        description:
          'Parse `celery inspect active` / `celery inspect reserved` / worker-report text into the worker list, per-worker task counts, a ' +
          'task-name histogram, reserved tasks and banner facts. Only the shapes Celery actually prints are read: task entries are recognized ' +
          'by their `{...}` `name` field, so a prose report yields empty lists plus coverage evidence instead of invented tasks. Over-budget ' +
          'input is refused and no broker connection is ever opened.',
        parameters: { text: TEXT_INPUT },
        result: RESULT_SPEC,
        run: (args, limits) => runCelery(args, limits),
      },
      opts,
    ),
  ]
  return tools.filter((tool): tool is NonNullable<typeof tool> => tool !== undefined)
}

/** The minimum a parsed report must expose for the shared receipt preamble. */
interface ReceiptedReport {
  coverage: CoverageSummary
  warnings: string[]
}

/** Shared preamble: measure the input, parse it, and collect the receivable notes. */
function parseReceipt<T extends ReceiptedReport>(
  args: Record<string, unknown>,
  limits: Limits,
  parse: (text: string) => T,
): { result: T; bytesIn: number; notes: string[] } {
  const text = String(args.text ?? '')
  const bytesIn = assertWithinInput(text, limits.maxInputBytes, 'report')
  const result = parse(text)
  const notes = [coverageNote(result.coverage), ...result.warnings]
  return { result, bytesIn, notes }
}

/** `python_traceback`. */
function runTraceback(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue> {
  const { result, bytesIn, notes } = parseReceipt(args, limits, parsePythonTraceback)
  const capped = capFrames(result, limits)
  if (capped.truncated) {
    notes.push(`frame list clipped to maxFrames=${limits.maxFrames} (of ${capped.frameCount})`)
  }
  return {
    result: capped.payload as unknown as JsonValue,
    meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(capped.payload)), truncated: capped.truncated, notes },
  }
}

/** Frame cap that also fixes up the pointers into the clipped list. */
function capFrames(report: TracebackReport, limits: Limits): { payload: TracebackReport; truncated: boolean; frameCount: number } {
  if (report.frames.length <= limits.maxFrames) {
    return { payload: report, truncated: false, frameCount: report.frames.length }
  }
  const kept = report.frames.slice(0, limits.maxFrames)
  const keptSet = new Set(kept.map((frame) => `${frame.file}\u0000${frame.line}\u0000${frame.function}`))
  const clippedBlocks = report.blocks.map((block) => ({
    ...block,
    frames: block.frames.filter((frame) => keptSet.has(`${frame.file}\u0000${frame.line}\u0000${frame.function}`)),
  }))
  const payload: TracebackReport = {
    ...report,
    frames: kept,
    blocks: clippedBlocks,
    deepest_frame: report.deepest_frame !== null && keptSet.has(frameKey(report.deepest_frame)) ? report.deepest_frame : null,
    deepest_project_frame:
      report.deepest_project_frame !== null && keptSet.has(frameKey(report.deepest_project_frame)) ? report.deepest_project_frame : null,
  }
  return { payload, truncated: true, frameCount: report.frames.length }
}

/** Stable key for the frame-cap set membership test. */
function frameKey(frame: { file: string; line: number | null; function: string }): string {
  return `${frame.file}\u0000${frame.line}\u0000${frame.function}`
}

/** `pytest_summary`. */
function runPytest(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue> {
  const { result, bytesIn, notes } = parseReceipt(args, limits, parsePytestSummary)
  const failures = clipItems(result.failures, limits.maxFailures)
  const errors = clipItems(result.errors, limits.maxFailures)
  const shortSummary = clipItems(result.short_summary, limits.maxFailures)
  const truncated = failures.truncated || errors.truncated || shortSummary.truncated
  if (failures.truncated) notes.push(`failure list clipped to maxFailures=${limits.maxFailures}`)
  if (errors.truncated) notes.push(`error list clipped to maxFailures=${limits.maxFailures}`)
  if (shortSummary.truncated) notes.push(`short summary clipped to maxFailures=${limits.maxFailures}`)
  const payload: PytestReport = {
    ...result,
    failures: failures.items,
    errors: errors.items,
    short_summary: shortSummary.items,
  }
  return {
    result: payload as unknown as JsonValue,
    meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(payload)), truncated, notes },
  }
}

/** `django_migrations`. */
function runMigrations(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue> {
  const { result, bytesIn, notes } = parseReceipt(args, limits, parseDjangoMigrations)
  const apps = clipItems(result.apps, limits.maxQueryGroups)
  if (apps.truncated) notes.push(`app list clipped to maxQueryGroups=${limits.maxQueryGroups}`)
  const payload: MigrationsReport = {
    ...result,
    apps: apps.items,
  }
  return {
    result: payload as unknown as JsonValue,
    meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(payload)), truncated: apps.truncated, notes },
  }
}

/** `django_sql_n_plus_one`. */
function runSql(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue> {
  const text = String(args.text ?? '')
  const bytesIn = assertWithinInput(text, limits.maxInputBytes, 'report')
  const minRepeats = clampInt(args.min_repeats, limits.minRepeats, 2, 10_000)
  const result = analyzeSqlLog(text, minRepeats, limits.maxQueryGroups)
  const notes = [coverageNote(result.coverage), ...result.warnings]
  if (minRepeats !== limits.minRepeats) notes.push(`repetition threshold overridden to min_repeats=${minRepeats}`)
  const payload: SqlReport = result
  return {
    result: payload as unknown as JsonValue,
    meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(payload)), truncated: result.groups_truncated, notes },
  }
}

/** `django_checks`. */
function runChecks(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue> {
  const { result, bytesIn, notes } = parseReceipt(args, limits, parseDjangoChecks)
  const findings = clipItems(result.findings, limits.maxFindings)
  if (findings.truncated) notes.push(`finding list clipped to maxFindings=${limits.maxFindings}`)
  const payload: ChecksReport = {
    ...result,
    findings: findings.items,
    deploy_findings: result.deploy_findings.filter((finding) => findings.items.includes(finding)),
  }
  return {
    result: payload as unknown as JsonValue,
    meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(payload)), truncated: findings.truncated, notes },
  }
}

/** `celery_report`. */
function runCelery(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue> {
  const { result, bytesIn, notes } = parseReceipt(args, limits, parseCeleryReport)
  const histogram = clipItems(result.task_histogram, limits.maxTaskEntries)
  const workers = clipItems(result.workers, limits.maxTaskEntries)
  const active = clipItems(result.active_tasks, limits.maxTaskEntries)
  const reserved = clipItems(result.reserved_tasks, limits.maxTaskEntries)
  const truncated = histogram.truncated || workers.truncated || active.truncated || reserved.truncated
  if (histogram.truncated) notes.push(`task histogram clipped to maxTaskEntries=${limits.maxTaskEntries}`)
  if (workers.truncated) notes.push(`worker list clipped to maxTaskEntries=${limits.maxTaskEntries}`)
  if (active.truncated || reserved.truncated) notes.push(`task list clipped to maxTaskEntries=${limits.maxTaskEntries}`)
  const payload: CeleryReport = {
    ...result,
    workers: workers.items,
    task_histogram: histogram.items,
    active_tasks: active.items,
    reserved_tasks: reserved.items,
  }
  return {
    result: payload as unknown as JsonValue,
    meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(payload)), truncated, notes },
  }
}

/** Clamp an integer argument into a closed range, falling back when it is absent. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}
