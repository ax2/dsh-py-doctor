/**
 * SQL log normalization and N+1 candidate detection.
 *
 * The shapes this reads are the ones Django actually produces: the
 * `connection.queries` repr, `django-debug-toolbar`'s SQL panel copy, and
 * `manage.py runserver -v2` query logs. All of them are multi-line SQL with
 * interpolated literals and `%s` placeholders, so the only reliable way to group
 * them is to normalize the statement first and count afterwards.
 *
 * Normalization is deliberately conservative and documented: it replaces
 * literals with `?` and collapses whitespace, which can merge two genuinely
 * different statements that differ only by a constant. The `example` field keeps
 * the original text so a human can always check the merge.
 * @module dsh-py-doctor/core/sql
 */
import { numberedLines } from './bytes.ts'
import { CoverageLedger, type Coverage } from './coverage.ts'

/** Grammar revision of {@link analyzeSqlLog}. */
export const SQL_PARSER_VERSION = 'sql-1'

/** Default repetition threshold for an N+1 candidate. */
export const DEFAULT_MIN_REPEATS = 3

/** Hard ceiling on distinct normalized statements the result may carry. */
export const MAX_GROUP_LIMIT = 500

/** One distinct normalized statement. */
export interface QueryGroup {
  /** Normalized statement, whitespace collapsed and literals replaced with `?`. */
  normalized: string
  /** How many times the statement appeared in the log. */
  count: number
  /** Leading verb, uppercased (`SELECT`, `UPDATE`, …), or `UNKNOWN`. */
  verb: string
  /** Table names seen in the statement, in first-appearance order. */
  tables: string[]
  /** First original occurrence, whitespace collapsed to one line. */
  example: string
  /** 1-based line number of the first occurrence. */
  first_line: number
  /** 1-based line numbers of every occurrence, capped at 64. */
  lines: number[]
  /** `true` when the group repeats at or above the requested threshold. */
  n_plus_one: boolean
}

/** Result of {@link analyzeSqlLog}. */
export interface SqlReport {
  /** Total statements read. */
  total_queries: number
  /** Number of distinct normalized statements. */
  distinct_queries: number
  /** Repetition threshold that was applied. */
  min_repeats: number
  /** Every group, most frequent first. */
  groups: QueryGroup[]
  /** Groups at or above the threshold, most frequent first. */
  candidates: QueryGroup[]
  /** `true` when the group list was clipped to the configured ceiling. */
  groups_truncated: boolean
  /** Non-fatal problems worth telling the model about. */
  warnings: string[]
  /** Coverage receipt for this parse. */
  coverage: Coverage
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu
const VERBS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'PRAGMA', 'SET', 'SHOW', 'CREATE', 'ALTER', 'DROP', 'EXPLAIN', 'VACUUM', 'ANALYZE'] as const
const VERB_SET = new Set<string>(VERBS)
/**
 * Prefixes the supported loggers put in front of a statement: an ISO timestamp,
 * a level, a `(0.001)` duration, a bare `0.001` duration, or `1 query)`.
 */
const STATEMENT_PREFIX = /^\s*(?:(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[,.]\d{3})?\s+)?(?:DEBUG|INFO|WARNING|ERROR)?\s*)?(?:\(\d+(?:\.\d+)?\)\s*|\d+(?:\.\d+)?\s*[ms]?s?\s*|\d+\s+quer(?:y|ies)\)\s*)?/u
/** `SELECT ... FROM x` / `JOIN x` / `UPDATE x` / `INSERT INTO x`. */
const TABLE_PATTERN = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"?([\w$]+)"?\s*\.\s*)?"?([\w$]+)"?/gu
const TABLE_KEYWORDS = new Set(['select', 'values', 'set', 'on', 'as', 'using'])
/** Clause keywords that can only open a continuation line of a statement. */
const CLAUSE_STARTERS = new Set([
  'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
  'ON', 'AND', 'OR', 'NOT', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT',
  'INTERSECT', 'VALUES', 'SET', 'RETURNING', 'USING', 'WHEN', 'THEN', 'ELSE', 'END', 'AS',
])
/** Trailing tokens that prove a statement was cut off mid-clause. */
const OPEN_TAIL = /(?:[,([+\-*/=<>|]|\b(?:AND|OR|NOT|ON|BY|FROM|WHERE|JOIN|SET|VALUES|SELECT|IN|AS|LIMIT|OFFSET|GROUP|ORDER|HAVING|UNION|USING|THEN|ELSE|WHEN|CASE|BEGIN|DISTINCT|ALL|INTO|UPDATE|INSERT|DELETE))$/iu

/**
 * Whether `next` continues the statement accumulated in `previous`.
 *
 * A continuation must be positively signalled: either the statement so far ends
 * mid-clause, or the new line opens a SQL clause. Anything else — a traceback, a
 * log banner, prose — ends the statement instead of being folded into it, which
 * is what keeps the group counts and the coverage receipt honest.
 */
function continuesSql(previous: string, next: string): boolean {
  const tail = previous.trim()
  if (tail.endsWith(';')) return false
  if (OPEN_TAIL.test(tail)) return true
  const word = /^\(?\s*([A-Za-z]+)/u.exec(next)?.[1]?.toUpperCase() ?? ''
  return CLAUSE_STARTERS.has(word)
}

/**
 * Normalize one SQL statement for grouping.
 *
 * The transformation is fixed and testable: replace string literals, numbers,
 * `%s`-style placeholders and parameter lists with `?`, then collapse whitespace.
 * Double-quoted `[\w$]+` tokens are kept because they are identifiers in every
 * supported dialect, while anything else in double quotes is treated as a value.
 * @param sql - raw statement text.
 */
export function normalizeSql(sql: string): string {
  let out = stripComments(sql)
  // The Django cursor logger appends the parameter tuple after the statement.
  // It is driver output, not SQL, so it is removed before its literals become `?`.
  out = out.replace(/(?:^|\s);?\s*args\s*=\s*\((?:[^()]|\([^()]*\))*\)\s*$/u, ' ')
  out = out.replace(/'(?:[^'\\]|\\.|'')*'/gu, '?')
  out = out.replace(/"(?:[^"\\]|\\.|"")*"/gu, (match) => (looksLikeIdentifier(match) ? match : '?'))
  out = out.replace(/\$[^$]*\$/gu, '?')
  out = out.replace(/X'[0-9A-Fa-f]*'/gu, '?')
  out = out.replace(/%(?:\([\w ]+\))?[sdrf]/gu, '?')
  out = out.replace(/(?<![\w$])-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w$])/gu, '?')
  out = out.replace(/\?(?:\s*,\s*\?)+/gu, '?')
  out = out.replace(/\s+/gu, ' ').trim()
  return out.replace(/;\s*$/u, '').trim()
}

/** Remove `--`, `#` and block comments without touching string literals. */
function stripComments(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    const ch = sql[index]!
    if (ch === "'" || ch === '"') {
      const quote = ch
      out += ch
      index += 1
      while (index < sql.length) {
        const inner = sql[index]!
        out += inner
        index += 1
        if (inner === '\\') {
          if (index < sql.length) {
            out += sql[index]!
            index += 1
          }
          continue
        }
        if (inner === quote) break
      }
      continue
    }
    if (ch === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      out += ' '
      continue
    }
    if (ch === '/' && sql[index + 1] === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index += 2
      out += ' '
      continue
    }
    if (ch === '#') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      out += ' '
      continue
    }
    out += ch
    index += 1
  }
  return out
}

/** Whether a double-quoted token is an identifier rather than a string value. */
function looksLikeIdentifier(quoted: string): boolean {
  const inner = quoted.slice(1, -1)
  return /^[\w$]+$/u.test(inner)
}

/** Best-effort verb of a normalized statement. */
export function verbOf(normalized: string): string {
  const match = /^([A-Za-z]+)/u.exec(normalized.trim())
  if (match === null) return 'UNKNOWN'
  const candidate = (match[1] ?? '').toUpperCase()
  if (VERB_SET.has(candidate)) return candidate
  if (candidate === 'SELECT' || candidate === 'WITH') return candidate
  return 'UNKNOWN'
}

/** Table names referenced by a normalized statement, first-appearance order. */
export function tablesOf(normalized: string): string[] {
  const tables: string[] = []
  for (const match of normalized.matchAll(TABLE_PATTERN)) {
    const name = match[2]
    if (name === undefined) continue
    if (TABLE_KEYWORDS.has(name.toLowerCase())) continue
    if (!tables.includes(name)) tables.push(name)
  }
  return tables
}

/**
 * Analyze a stream of logged SQL statements.
 * @param text - log text: one statement per line, or multi-line statements, or
 * JSON-lines `{"sql": "..."}` records.
 * @param minRepeats - repetition threshold for {@link SqlReport.candidates}.
 * @param maxGroups - ceiling on distinct groups returned.
 */
export function analyzeSqlLog(text: string, minRepeats = DEFAULT_MIN_REPEATS, maxGroups = MAX_GROUP_LIMIT): SqlReport {
  const lines = numberedLines(text)
  const ledger = new CoverageLedger()
  for (const line of lines) ledger.see(line.number, line.text)

  const warnings: string[] = []
  const groups = new Map<string, QueryGroup>()
  let total = 0
  let bannerCount = 0
  let jsonRecords = 0

  let pending = ''
  let pendingLine = 0

  const flush = (): void => {
    if (pending.trim().length === 0) {
      pending = ''
      return
    }
    const normalized = normalizeSql(pending)
    if (normalized.length === 0) {
      pending = ''
      return
    }
    total += 1
    const example = pending.replace(/\s+/gu, ' ').trim()
    const existing = groups.get(normalized)
    if (existing === undefined) {
      groups.set(normalized, {
        normalized,
        count: 1,
        verb: verbOf(normalized),
        tables: tablesOf(normalized),
        example,
        first_line: pendingLine,
        lines: [pendingLine],
        n_plus_one: false,
      })
    } else {
      existing.count += 1
      if (existing.lines.length < 64) existing.lines.push(pendingLine)
    }
    pending = ''
  }

  for (const { number, text: raw } of lines) {
    const line = raw.replace(ANSI, '').replace(/\s+$/u, '')
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      if (pending.length > 0) flush()
      continue
    }

    const json = jsonLineOf(trimmed)
    if (json !== null) {
      if (pending.length > 0) flush()
      if (json.sql === null) {
        warnings.push(`line ${number}: JSON-lines record has no \`sql\`, \`query\` or \`statement\` field`)
        ledger.reject(number)
        continue
      }
      jsonRecords += 1
      pending = json.sql
      pendingLine = number
      flush()
      ledger.recognize(number)
      continue
    }

    const stripped = line.replace(STATEMENT_PREFIX, '')
    const firstWord = /^\(?([A-Za-z]+)/u.exec(stripped)?.[1]?.toUpperCase() ?? ''
    if (VERB_SET.has(firstWord)) {
      if (pending.length > 0) flush()
      pending = stripped
      pendingLine = number
      ledger.recognize(number)
      continue
    }

    if (/^(Quit the server|Watching for file changes|Django version|Starting development server|Performing system checks|System check identified|HTTP|Not Found|Internal Server Error)/u.test(trimmed)) {
      if (pending.length > 0) flush()
      bannerCount += 1
      ledger.consume(number)
      continue
    }

    if (pending.length > 0 && continuesSql(pending, stripped)) {
      // Continuation of a multi-line statement.
      pending = `${pending} ${stripped}`
      ledger.consume(number)
      continue
    }
    if (pending.length > 0) {
      // The buffer cannot absorb this line, so the statement ends here and the
      // line is given its own chance to be understood.
      flush()
      if (VERB_SET.has(firstWord)) {
        pending = stripped
        pendingLine = number
        ledger.recognize(number)
        continue
      }
    }

    // `connection.queries` dumps sometimes prefix each statement with a duration
    // like `0.001`; a bare numeric line is a duration, not SQL.
    if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
      bannerCount += 1
      ledger.consume(number)
      continue
    }

    ledger.reject(number)
  }
  flush()

  const ordered = [...groups.values()].sort((left, right) => right.count - left.count || left.first_line - right.first_line)
  const clipped = ordered.length > maxGroups
  const kept = clipped ? ordered.slice(0, maxGroups) : ordered
  for (const group of kept) group.n_plus_one = group.count >= minRepeats
  const candidates = kept.filter((group) => group.n_plus_one)

  if (total === 0) warnings.push('no SQL statement was recognized; expected query text or a JSON-lines query log')
  if (jsonRecords > 0) warnings.push(`${jsonRecords} JSON-lines record(s) were read through their \`sql\` field`)
  if (bannerCount > 0) warnings.push(`${bannerCount} non-query log line(s) were recognized and skipped`)
  if (clipped) warnings.push(`distinct statement list clipped to ${maxGroups} entries`)

  return {
    total_queries: total,
    distinct_queries: groups.size,
    min_repeats: minRepeats,
    groups: kept,
    candidates,
    groups_truncated: clipped,
    warnings,
    coverage: ledger.coverage(SQL_PARSER_VERSION),
  }
}

/**
 * Recognize a `{"sql": "..."}` JSON-lines record.
 *
 * Returning a non-null object with `sql: null` distinguishes "this is a JSON
 * record but it carries no statement" from "this is not JSON at all", so the
 * former can be reported instead of silently treated as a continuation line.
 * @param trimmed - trimmed input line.
 */
function jsonLineOf(trimmed: string): { sql: string | null } | null {
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const sql = record.sql ?? record.query ?? record.statement
  if (typeof sql === 'string' && sql.trim().length > 0) return { sql }
  return { sql: null }
}
