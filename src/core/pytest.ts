/**
 * pytest output parser.
 *
 * pytest prints a machine-stable final status line but a human-shaped failure
 * report, and the amount of detail depends entirely on the flags the operator
 * happened to pass (`-q`, `-ra`, `--tb=short`, `--durations=N`). This parser
 * therefore reads whatever the run actually printed and records, in the receipt,
 * which sections were absent — an absent short-summary block is a fact about the
 * invocation, not a parse failure.
 * @module dsh-py-doctor/core/pytest
 */
import { numberedLines } from './bytes.ts'
import { CoverageLedger, type Coverage } from './coverage.ts'

/** Grammar revision of {@link parsePytestSummary}. */
export const PYTEST_PARSER_VERSION = 'pytest-1'

/** Longest assertion excerpt kept per failure. */
export const MAX_EXCERPT_LINES = 12

/** One entry of the `short test summary info` block. */
export interface ShortSummaryEntry {
  /** `passed`, `failed`, `error`, `skipped`, `xfailed`, `xpassed`, `rerun` or `unknown`. */
  status: string
  /** Node id, e.g. `tests/test_views.py::TestCheckout::test_apply_coupon`. */
  test_id: string
  /** Verbatim text after the ` - ` separator, or `''`. */
  detail: string
}

/** One failure or error, with the excerpt pytest printed for it. */
export interface TestFailure {
  /** Node id as printed in the section header. */
  test_id: string
  /** Source file the test lives in, when the header carried one. */
  file: string | null
  /** 1-based source line, when the header carried one. */
  line: number | null
  /** `FAILED` or `ERROR`. */
  kind: 'FAILED' | 'ERROR'
  /** 1-based line of the section header, or `0` when the entry came from the short summary. */
  header_line: number
  /** The assertion excerpt without the `E ` prefix, capped at {@link MAX_EXCERPT_LINES}. */
  excerpt: string[]
  /** `true` when the excerpt exceeded {@link MAX_EXCERPT_LINES}. */
  excerpt_truncated: boolean
}

/** One `--durations` row. */
export interface DurationEntry {
  /** Seconds as printed. */
  seconds: number
  /** `call`, `setup` or `teardown`. */
  phase: string
  /** Test id, or a `N tests` placeholder row. */
  test_id: string
}

/** Result of {@link parsePytestSummary}. */
export interface PytestReport {
  /** Normalized outcome counts; absent counters are `0`. */
  counts: {
    passed: number
    failed: number
    errors: number
    skipped: number
    xfailed: number
    xpassed: number
    warnings: number
    deselected: number
  }
  /** Collected tests derived from the counters (selected outcomes only). */
  total: number
  /** Collected tests, when the status line printed `X selected`. */
  selected: number | null
  /** Wall-clock seconds, when the status line printed one. */
  duration_seconds: number | null
  /** The verbatim final status line, or `null` when the report has none. */
  status_line: string | null
  /** 1-based line of the status line. */
  status_line_number: number | null
  /** Outcome shown by a leading non-status banner (`no tests ran`, `interrupted`). */
  exit_status: string | null
  /** Failures with their excerpts. */
  failures: TestFailure[]
  /** Errors with their excerpts. */
  errors: TestFailure[]
  /** Entries of the `short test summary info` block, in print order. */
  short_summary: ShortSummaryEntry[]
  /** Slowest tests, descending, when `--durations` was passed. */
  durations: DurationEntry[]
  /** Non-fatal problems worth telling the model about. */
  warnings: string[]
  /** Coverage receipt for this parse. */
  coverage: Coverage
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu
const COUNTER = /(\d+) (passed|failed|error|errors|skipped|xfailed|xpassed|warning|warnings|deselected|selected|rerun|reruns)\b/gu
const DURATION = /in (\d+(?:\.\d+)?)s(?:\s|\(|$)/u
const SHORT_SUMMARY = /^=+ short test summary info =+$/u
const DURATIONS_HEADER = /^=+ slowest (\d+ )?durations =+$/u
const FAILURES_HEADER = /^=+ FAILURES =+$/u
const ERRORS_HEADER = /^=+ ERRORS =+$/u
const SECTION_END = /^=+ .* =+$/u
const FAILED_HEADER = /^_{5,} (?<id>.*?) _{5,}$/u
const ERROR_HEADER = /^_{5,} ERROR at (?:(?:setup|teardown) of )?(?<id>.*?) _{5,}$/u
const NODE_LOCATION = /^(?<file>[^\s:]+\.py):(?<line>\d+): /u
/** The `E ` marker pytest prints in front of an assertion body line. */
const E_MARKER = /^\s*E(?:\s+|$)/u
const SHORT_LINE = /^(?<status>PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS|RERUN)\b ?(?<rest>.*)$/u
const DURATION_LINE = /^(?<seconds>\d+(?:\.\d+)?)s\s+(?<phase>call|setup|teardown)\s+(?<id>\S.*)$/u
const EXIT_BANNER = /^(?:no tests ran|interrupted|error|usage error|collected \d+ items? \/ \d+ errors?|ERROR \S+)(?: in \d+(?:\.\d+)?s)?$/u
/**
 * A progress line such as `........................F...........E   [ 92%]`.
 *
 * Recognized so that it counts as read rather than unknown: it carries outcome
 * information that the status line already summarizes.
 */
const PROGRESS = /^[.sFExX]+\s*(?:\[\s*\d+%\]|[.sFExX]*)$/u
/** A separator or banner line made only of `=`, `_`, `!`, `-` or spaces. */
const RULE = /^[=_.\-!+*]{3,}$/u

/** Mutable accumulator used while a section body is being read. */
interface MutableFailure {
  test_id: string
  file: string | null
  line: number | null
  kind: 'FAILED' | 'ERROR'
  header_line: number
  error_lines: string[]
}

/** Which part of the pytest report the reader is currently inside. */
type PytestSection = 'idle' | 'failures' | 'errors' | 'short_summary' | 'durations'

/**
 * Parse pytest output.
 * @param text - combined stdout/stderr of a pytest invocation.
 */
export function parsePytestSummary(text: string): PytestReport {
  const lines = numberedLines(text)
  const ledger = new CoverageLedger()
  for (const line of lines) ledger.see(line.number, line.text)

  const warnings: string[] = []
  const failures: TestFailure[] = []
  const errors: TestFailure[] = []
  const shortSummary: ShortSummaryEntry[] = []
  const durations: DurationEntry[] = []
  const accumulators = new Map<MutableFailure, TestFailure>()

  // The holder defeats control-flow narrowing of the section state: several
  // branches below reassign it, and a narrowed union would make the later
  // comparisons unreachable as far as the type checker is concerned.
  const state: { mode: PytestSection } = { mode: 'idle' }
  let active: MutableFailure | null = null
  let statusLine: string | null = null
  let statusLineNumber: number | null = null
  let exitStatus: string | null = null

  const commit = (): void => {
    if (active === null) return
    const frozen = accumulators.get(active)
    if (frozen !== undefined) {
      frozen.excerpt = active.error_lines.slice(0, MAX_EXCERPT_LINES)
      frozen.excerpt_truncated = active.error_lines.length > MAX_EXCERPT_LINES
    }
    active = null
  }

  const beginSection = (kind: PytestSection): void => {
    commit()
    state.mode = kind
  }

  for (const { number, text: raw } of lines) {
    const line = raw.replace(ANSI, '').replace(/\s+$/u, '')
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    if (PROGRESS.test(trimmed)) {
      ledger.recognize(number)
      continue
    }

    // These two shapes are recognized everywhere in the report and are tested
    // before the section dispatch because a rotated-away `FAILURES` header leaves
    // the session banner in `idle` mode. Assertion body lines are handled after
    // the dispatch so an active failure can still capture them.
    if (EXIT_BANNER.test(trimmed)) {
      exitStatus = trimmed
      ledger.recognize(number)
      continue
    }
    if (RULE.test(trimmed)) {
      ledger.recognize(number)
      continue
    }

    if (SHORT_SUMMARY.test(trimmed)) {
      commit()
      state.mode = 'short_summary'
      ledger.recognize(number)
      continue
    }

    if (DURATIONS_HEADER.test(trimmed)) {
      commit()
      state.mode = 'durations'
      ledger.recognize(number)
      continue
    }

    if (FAILURES_HEADER.test(trimmed)) {
      beginSection('failures')
      ledger.recognize(number)
      continue
    }

    if (ERRORS_HEADER.test(trimmed)) {
      beginSection('errors')
      ledger.recognize(number)
      continue
    }

    if (state.mode === 'short_summary') {
      const entry = parseShortSummaryLine(trimmed)
      if (entry !== null) {
        shortSummary.push(entry)
        ledger.recognize(number)
        continue
      }
      if (COUNTER.test(trimmed)) {
        // pytest prints the status line directly after the short summary when no
        // final rule is drawn, so close the section here rather than rejecting it.
        COUNTER.lastIndex = 0
        statusLine = trimmed
        statusLineNumber = number
        state.mode = 'idle'
        ledger.recognize(number)
        continue
      }
      COUNTER.lastIndex = 0
      ledger.reject(number)
      continue
    }

    if (state.mode === 'durations') {
      const entry = parseDurationLine(trimmed)
      if (entry !== null) {
        durations.push(entry)
        ledger.recognize(number)
        continue
      }
      if (COUNTER.test(trimmed)) {
        COUNTER.lastIndex = 0
        statusLine = trimmed
        statusLineNumber = number
        state.mode = 'idle'
        ledger.recognize(number)
        continue
      }
      COUNTER.lastIndex = 0
      ledger.reject(number)
      continue
    }

    if (state.mode === 'failures' || state.mode === 'errors') {
      const errorHeader = ERROR_HEADER.exec(trimmed)
      if (errorHeader !== null) {
        commit()
        active = {
          test_id: (errorHeader.groups?.id ?? '').trim(),
          file: null,
          line: null,
          kind: 'ERROR',
          header_line: number,
          error_lines: [],
        }
        locate(active, line)
        const frozen = freeze(active)
        errors.push(frozen)
        accumulators.set(active, frozen)
        ledger.recognize(number)
        continue
      }
      const failedHeader = FAILED_HEADER.exec(trimmed)
      if (failedHeader !== null) {
        commit()
        active = {
          test_id: (failedHeader.groups?.id ?? '').trim(),
          file: null,
          line: null,
          kind: 'FAILED',
          header_line: number,
          error_lines: [],
        }
        locate(active, line)
        const frozen = freeze(active)
        failures.push(frozen)
        accumulators.set(active, frozen)
        ledger.recognize(number)
        continue
      }
      if (active !== null) {
        if (active.file === null) {
          locate(active, line)
          const frozen = accumulators.get(active)
          if (frozen !== undefined) {
            frozen.file = active.file
            frozen.line = active.line
            frozen.test_id = active.test_id
          }
        }
        if (/^\s*E\s*$/u.test(line)) active.error_lines.push('')
        else if (E_MARKER.test(line)) active.error_lines.push(trimmed.replace(/^E\s*/u, '').replace(/\s+$/u, ''))
        ledger.consume(number)
        continue
      }
      // A body line with no header above it. The paste may have started mid
      // excerpt, so fall through to the shared checks instead of rejecting
      // outright; only a line that no rule claims is reported as unknown.
    }

    // A status line is only a status line outside every detail section, because
    // assertion excerpts and duration rows legitimately contain text such as
    // `2 passed` or `0.83s call ...`.
    if (COUNTER.test(trimmed)) {
      COUNTER.lastIndex = 0
      statusLine = trimmed
      statusLineNumber = number
      ledger.recognize(number)
      continue
    }
    COUNTER.lastIndex = 0

    // An excerpt line whose `FAILURES` header was rotated away is still
    // recognizable assertion text, so it is counted as read, not unknown.
    if (E_MARKER.test(line)) {
      ledger.recognize(number)
      continue
    }

    ledger.reject(number)
  }
  commit()

  const counts = { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0, warnings: 0, deselected: 0 }
  let duration: number | null = null
  let selected: number | null = null
  if (statusLine !== null) {
    for (const match of statusLine.matchAll(COUNTER)) {
      const kind = match[2] ?? ''
      const count = Number(match[1] ?? '0')
      if (kind === 'passed') counts.passed = count
      else if (kind === 'failed') counts.failed = count
      else if (kind === 'error' || kind === 'errors') counts.errors = count
      else if (kind === 'skipped') counts.skipped = count
      else if (kind === 'xfailed') counts.xfailed = count
      else if (kind === 'xpassed') counts.xpassed = count
      else if (kind === 'warning' || kind === 'warnings') counts.warnings = count
      else if (kind === 'deselected') counts.deselected = count
      else if (kind === 'selected') selected = count
    }
    const durationMatch = DURATION.exec(statusLine)
    if (durationMatch !== null) duration = Number(durationMatch[1] ?? '0')
  }

  // The short summary is the authoritative per-test outcome list; when the
  // FAILURES/ERRORS sections were not printed, it is also the only place a
  // failure's identity survives, so materialize a header-less entry for it.
  // Section headers name only the function while the summary names the node id,
  // so identity is compared on the trailing name.
  for (const entry of shortSummary) {
    const key = trailingName(entry.test_id)
    if (entry.status === 'failed' && !failures.some((failure) => trailingName(failure.test_id) === key)) {
      const location = locationOf(entry.test_id)
      failures.push({
        test_id: entry.test_id,
        file: location.file,
        line: location.line,
        kind: 'FAILED',
        header_line: 0,
        excerpt: [],
        excerpt_truncated: false,
      })
    }
    if (entry.status === 'error' && !errors.some((error) => trailingName(error.test_id) === key)) {
      const location = locationOf(entry.test_id)
      errors.push({
        test_id: entry.test_id,
        file: location.file,
        line: location.line,
        kind: 'ERROR',
        header_line: 0,
        excerpt: [],
        excerpt_truncated: false,
      })
    }
  }

  if (statusLine === null) {
    warnings.push('no pytest status line found (expected a line such as `1 failed, 2 passed in 0.42s`); every counter is reported as 0')
  }
  if (statusLine !== null && shortSummary.length === 0) {
    warnings.push('no `short test summary info` block found; pass `-ra`/`-rf` to get per-test outcomes')
  }
  if (counts.failed + counts.errors > 0 && failures.length === 0 && errors.length === 0) {
    warnings.push(`${counts.failed + counts.errors} failing outcome(s) counted but neither the FAILURES section nor the short summary was printed`)
  }

  durations.sort((left, right) => right.seconds - left.seconds)

  return {
    counts,
    total: counts.passed + counts.failed + counts.errors + counts.skipped + counts.xfailed + counts.xpassed,
    selected,
    duration_seconds: duration,
    status_line: statusLine,
    status_line_number: statusLineNumber,
    exit_status: exitStatus,
    failures,
    errors,
    short_summary: shortSummary,
    durations,
    warnings,
    coverage: ledger.coverage(PYTEST_PARSER_VERSION),
  }
}

/** Snapshot an accumulator into its frozen public form. */
function freeze(active: MutableFailure): TestFailure {
  return {
    test_id: active.test_id,
    file: active.file,
    line: active.line,
    kind: active.kind,
    header_line: active.header_line,
    excerpt: [],
    excerpt_truncated: false,
  }
}

/**
 * Extract `file.py:LINE` from a body line into the accumulator.
 *
 * pytest prints the node id on the `____ test_x ____` header only with `-v`;
 * otherwise the first plain location line of the traceback is the only place the
 * test's file and line appear.
 */
function locate(active: MutableFailure, line: string): void {
  if (active.file !== null) return
  const location = NODE_LOCATION.exec(line)
  if (location === null) return
  active.file = location.groups?.file ?? null
  active.line = Number(location.groups?.line ?? '0')
}

/** The trailing test name of a node id, used to match a section to a summary row. */
function trailingName(id: string): string {
  const marker = id.lastIndexOf('::')
  return marker >= 0 ? id.slice(marker + 2) : id
}

/** Split `tests/test_x.py:12: message` or `tests/test_x.py::test_y` into parts. */
function locationOf(id: string): { file: string | null; line: number | null } {  const match = /^(?<file>[^\s:]+\.py)(?::(?<line>\d+))?/u.exec(id)
  if (match === null) return { file: null, line: null }
  const line = match.groups?.line
  return { file: match.groups?.file ?? null, line: line === undefined ? null : Number(line) }
}

/** Parse one `FAILED tests/x.py::test_y - AssertionError: ...` line. */
function parseShortSummaryLine(trimmed: string): ShortSummaryEntry | null {
  const match = SHORT_LINE.exec(trimmed)
  if (match === null) return null
  const status = (match.groups?.status ?? '').toLowerCase()
  const rest = match.groups?.rest ?? ''
  const dash = rest.indexOf(' - ')
  const testId = (dash >= 0 ? rest.slice(0, dash) : rest).trim()
  return { status, test_id: testId, detail: dash >= 0 ? rest.slice(dash + 3) : '' }
}

/** Parse one `0.12s call tests/test_x.py::test_y` row. */
function parseDurationLine(trimmed: string): DurationEntry | null {
  const match = DURATION_LINE.exec(trimmed)
  if (match === null) return null
  return {
    seconds: Number(match.groups?.seconds ?? '0'),
    phase: match.groups?.phase ?? 'call',
    test_id: (match.groups?.id ?? '').trim(),
  }
}
