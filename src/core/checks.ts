/**
 * `manage.py check` / `check --deploy` parser.
 *
 * Django prints findings as `LEVELS: message`, optionally suffixed with `(id)`,
 * followed by an indented `HINT:` line. A `check --deploy` run adds `?:` item
 * blocks on top of the same format, so the parser tracks whether a `?:` block was
 * seen before a finding instead of guessing from the severity.
 * @module dsh-py-doctor/core/checks
 */
import { numberedLines } from './bytes.ts'
import { CoverageLedger, type Coverage } from './coverage.ts'

/** Grammar revision of {@link parseDjangoChecks}. */
export const CHECKS_PARSER_VERSION = 'checks-1'

/** Severity levels Django can print. */
export type CheckLevel = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG'

/** One finding. */
export interface CheckFinding {
  /** Severity of this finding. */
  level: CheckLevel
  /** Django's message immediately after the level prefix. */
  message: string
  /** Diagnostic id in parentheses (`fields.E130`), or `null` when Django printed none. */
  id: string | null
  /** `true` when this finding came from a `check --deploy` item block (`?:`). */
  deploy: boolean
  /** Subject the finding applies to, best-effort, or `null`. */
  object: string | null
  /** Text of the `HINT:` line(s) that follow, or `null`. */
  hint: string | null
  /** 1-based line the finding started on. */
  line: number
}

/** Result of {@link parseDjangoChecks}. */
export interface ChecksReport {
  /** Every finding, in print order. */
  findings: CheckFinding[]
  /** Findings per severity. */
  counts: { ERROR: number; WARNING: number; INFO: number; DEBUG: number }
  /** Findings that came from a `check --deploy` item block. */
  deploy_findings: CheckFinding[]
  /** The verbatim `System check identified ...` line, or `null`. */
  summary_line: string | null
  /** Number of issues the summary line claimed, or `null`. */
  issue_count: number | null
  /** `true` when the summary line said the check found no issues. */
  clean: boolean
  /** `true` when a `?:` deploy item or a deploy section header was present. */
  deploy_section_present: boolean
  /** Non-fatal problems worth telling the model about. */
  warnings: string[]
  /** Coverage receipt for this parse. */
  coverage: Coverage
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu
/** A bare `WARNINGS:` / `ERRORS:` line, which introduces the findings under it. */
const LEVEL_HEADER = /^(?<level>ERRORS|WARNINGS|ERROR|WARNING|INFO|DEBUG):$/u
/** A level-prefixed finding, `WARNING: shop.Order.total: (fields.W161) ...`. */
const LEVEL_PREFIXED = /^(?<level>ERRORS|WARNINGS|ERROR|WARNING|INFO|DEBUG):\s+(?<rest>\S.*)$/u
/** Django's diagnostic id shape: `fields.W161`, `security.W004`, `admin.E403`. */
const ID_SHAPE = '[a-z_][\\w]*\\.[A-Za-z]?\\d+'
/** `shop.Order.total: (fields.W161) message`, or `?: (security.W004) message`. */
const LABELED_FINDING = new RegExp(`^(?<object>[\\w.]+|\\?):\\s*\\((?<id>${ID_SHAPE})\\)\\s*(?<message>.*)$`, 'u')
/** `(fields.W161) message` with no label at all. */
const ID_FINDING = new RegExp(`^\\((?<id>${ID_SHAPE})\\)\\s*(?<message>.+)$`, 'u')
const SUMMARY = /^System check identified (?<count>no issues|\d+ issues?)(?: \((?<detail>[^)]*)\))?\.?$/u
const ISSUES_BANNER = /^System check identified some issues:?$/u
const HINT = /^HINT:\s*(?<hint>.*)$/u
const BANNER = /^(Performing system checks|No changes detected|Operations to perform|Watching for file changes)/u
const TRAILING_ID = new RegExp(`\\s*\\((?<id>${ID_SHAPE})\\)\\s*$`, 'u')

/**
 * Parse `manage.py check` output.
 * @param text - report text, already decoded.
 */
export function parseDjangoChecks(text: string): ChecksReport {
  const lines = numberedLines(text)
  const ledger = new CoverageLedger()
  for (const line of lines) ledger.see(line.number, line.text)

  const warnings: string[] = []
  const findings: CheckFinding[] = []
  let current: CheckFinding | null = null
  let sectionLevel: CheckLevel | null = null
  let summaryLine: string | null = null
  let issueCount: number | null = null
  let clean = false
  let deployItemsSeen = false
  let bannerCount = 0

  for (const { number, text: raw } of lines) {
    const line = raw.replace(ANSI, '').replace(/\s+$/u, '')
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    const summary = SUMMARY.exec(trimmed)
    if (summary !== null) {
      summaryLine = trimmed
      const count = summary.groups?.count ?? ''
      if (count === 'no issues') {
        clean = true
        issueCount = 0
      } else {
        issueCount = Number(/(\d+)/u.exec(count)?.[1] ?? '0')
      }
      ledger.recognize(number)
      continue
    }

    if (ISSUES_BANNER.test(trimmed)) {
      ledger.recognize(number)
      continue
    }

    const hint = HINT.exec(trimmed)
    if (hint !== null) {
      const hintText = hint.groups?.hint ?? ''
      if (current === null) {
        warnings.push(`line ${number}: HINT printed before any finding`)
        ledger.reject(number)
      } else {
        current.hint = current.hint === null ? hintText : `${current.hint} ${hintText}`
        ledger.consume(number)
      }
      continue
    }

    // `WARNINGS:` with nothing after the colon introduces the findings below it;
    // it is not itself a finding.
    const levelHeader = LEVEL_HEADER.exec(trimmed)
    if (levelHeader !== null) {
      const level = normalizeLevel(levelHeader.groups?.level ?? '')
      sectionLevel = level
      ledger.recognize(number)
      continue
    }

    const labeled = LABELED_FINDING.exec(trimmed)
    const identified = labeled === null ? ID_FINDING.exec(trimmed) : null
    if (labeled !== null || identified !== null) {
      const level = sectionLevel
      if (level === null) {
        // Django always prints a `WARNINGS:`/`ERRORS:` header before a finding, so
        // the severity of this one is genuinely unknown and is not invented.
        warnings.push(`line ${number}: finding printed before any level header; its severity is unknown`)
        ledger.reject(number)
        continue
      }
      const label = labeled?.groups?.object ?? null
      const deployItem = label === '?'
      if (deployItem) deployItemsSeen = true
      current = makeFinding(
        level,
        labeled?.groups?.message ?? identified?.groups?.message ?? '',
        number,
        deployItem,
        deployItem ? null : label,
        labeled?.groups?.id ?? identified?.groups?.id ?? null,
      )
      findings.push(current)
      ledger.recognize(number)
      continue
    }

    const prefixed = LEVEL_PREFIXED.exec(trimmed)
    if (prefixed !== null) {
      const level = normalizeLevel(prefixed.groups?.level ?? '')
      if (level !== null) {
        sectionLevel = level
        current = makeFinding(level, prefixed.groups?.rest ?? '', number, deployItemsSeen)
        findings.push(current)
        ledger.recognize(number)
        continue
      }
    }

    if (current !== null && /^[ \t]/u.test(raw)) {
      // A wrapped message or the body of an indented `HINT:` paragraph. Django
      // indents continuations, so an unindented line is never absorbed here.
      current.message = current.message.length === 0 ? trimmed : `${current.message} ${trimmed}`
      ledger.consume(number)
      continue
    }

    if (BANNER.test(trimmed)) {
      bannerCount += 1
      ledger.consume(number)
      continue
    }

    ledger.reject(number)
  }

  const counts = { ERROR: 0, WARNING: 0, INFO: 0, DEBUG: 0 }
  for (const finding of findings) counts[finding.level] += 1
  const deployFindings = findings.filter((finding) => finding.deploy)

  if (findings.length === 0 && !clean) {
    warnings.push('no findings and no `System check identified ...` summary; this input does not look like `manage.py check` output')
  }
  if (findings.length > 0 && summaryLine === null) {
    warnings.push('findings were recognized but no `System check identified ...` summary line was printed; the total issue count is unknown')
  }
  if (issueCount !== null && issueCount !== findings.length) {
    warnings.push(`the summary line reports ${issueCount} issue(s) but ${findings.length} finding block(s) were recognized`)
  }
  if (bannerCount > 0) warnings.push(`${bannerCount} surrounding command line(s) were recognized and skipped`)

  return {
    findings,
    counts,
    deploy_findings: deployFindings,
    summary_line: summaryLine,
    issue_count: issueCount,
    clean,
    deploy_section_present: deployItemsSeen,
    warnings,
    coverage: ledger.coverage(CHECKS_PARSER_VERSION),
  }
}

/** Map the printed prefix to a severity; `null` never happens for a matched prefix. */
function normalizeLevel(prefix: string): CheckLevel | null {
  if (prefix === 'ERROR' || prefix === 'ERRORS') return 'ERROR'
  if (prefix === 'WARNING' || prefix === 'WARNINGS') return 'WARNING'
  if (prefix === 'INFO') return 'INFO'
  if (prefix === 'DEBUG') return 'DEBUG'
  return null
}

/** Build a finding from the message body Django printed after the id. */
function makeFinding(
  level: CheckLevel,
  body: string,
  line: number,
  deploy: boolean,
  object: string | null = null,
  id: string | null = null,
): CheckFinding {
  let message = body.trim()
  let resolvedId = id
  if (resolvedId === null) {
    const matched = TRAILING_ID.exec(message)
    if (matched !== null) {
      resolvedId = matched.groups?.id ?? null
      message = message.slice(0, matched.index).trim()
    }
  }
  return { level, message, id: resolvedId, deploy, object: object ?? objectOf(message), hint: null, line }
}

/** Best-effort subject of a finding, derived from the message shape. */
function objectOf(message: string): string | null {
  const patterns = [
    /field (?<object>[\w.]+)\.(?<field>[\w]+)/u,
    /model (?<object>[\w.]+)/u,
    /(?<object>[\w.]+)\.(?<field>[\w]+):/u,
    /'(?<object>[\w.]+)'/u,
    /`(?<object>[\w.]+)`/u,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(message)
    const object = match?.groups?.object
    if (object !== undefined && object.length > 0) return object
  }
  return null
}
