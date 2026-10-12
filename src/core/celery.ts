/**
 * `celery inspect` / worker report parser.
 *
 * Celery's inspect output is a Python `repr` of a dictionary keyed by node name,
 * while the worker banner and `celery report` use a plain `key: value` layout.
 * This parser reads both, counts what it can prove, and leaves anything else to
 * the coverage receipt rather than inventing a task list.
 * @module dsh-py-doctor/core/celery
 */
import { numberedLines } from './bytes.ts'
import { CoverageLedger, type Coverage } from './coverage.ts'

/** Grammar revision of {@link parseCeleryReport}. */
export const CELERY_PARSER_VERSION = 'celery-1'

/** One worker's task payload. */
export interface CeleryWorker {
  /** Node name, e.g. `celery@worker-1`. */
  name: string
  /** Task names listed for this worker, in print order. */
  tasks: string[]
  /** How many task entries were read. */
  task_count: number
  /** 1-based line of the header that introduced this worker. */
  line: number
}

/** One row of the task-name histogram. */
export interface TaskHistogramEntry {
  /** Task name as printed. */
  task: string
  /** Number of occurrences across the whole report. */
  count: number
}

/** One `key: value` fact from the banner or `celery report`. */
export interface CeleryFact {
  /** Fact name, lowercased and underscore-joined. */
  key: string
  /** Value as printed. */
  value: string
  /** 1-based line the fact was printed on. */
  line: number
}

/** Result of {@link parseCeleryReport}. */
export interface CeleryReport {
  /** Workers with a task list, in print order. */
  workers: CeleryWorker[]
  /** Every node name mentioned anywhere in the report. */
  worker_names: string[]
  /** Total task entries across every worker block. */
  active_task_count: number
  /** Task names, in print order, with duplicates preserved. */
  active_tasks: string[]
  /** Task-name histogram, most frequent first then alphabetical. */
  task_histogram: TaskHistogramEntry[]
  /** Reserved tasks, when the report carried a reserved/prefetch section. */
  reserved_tasks: string[]
  /** `worker_count` and friends, when the report printed them. */
  facts: CeleryFact[]
  /** Reports the tool could not attribute to a supported section. */
  warnings: string[]
  /** Coverage receipt for this parse. */
  coverage: Coverage
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu
/** ` -> celery@worker-1: OK` and the `celery@worker-1: OK` banner form. */
const PING_LINE = /^(?:->\s*)?(?<name>[\w.@:-]*celery@[\w.@:-]+)\s*:\s*(?<status>OK|pong|offline|unreachable.*)$/iu
/** `"celery@worker-1": {` opens a per-node mapping. */
const NODE_HEADER = /^(?<quote>["']?)(?<name>[\w.@:-]*celery@[\w.@:-]+)\k<quote>\s*:\s*\{?\s*$/u
/** `{ 'id': '...', 'name': 'app.tasks.add', ... }` */
/**
 * A task entry's name field. Celery prints task entries both as `* name: x` and
 * as an inline Python dict `{'name': 'x', 'id': ...}`, so the field is searched
 * anywhere on the line. A genuine stats row that happens to use a `name` key is
 * therefore read as a task entry; that is the one place the two shapes collide.
 */
const TASK_NAME = /["']?name["']?\s*:\s*["']?(?<task>[A-Za-z_][\w.]*)["']?/u
/** The marker celery prints for a worker with nothing in the requested section. */
const EMPTY_MARKER = /^-\s*empty\s*-$/u
/** Fields of a task entry; consumed with the entry instead of counted as facts. */
const TASK_FIELD = /^(?:["']?(?:id|args|kwargs|worker_pid|eta|expires|priority|hostname|time_start|delivery_info|type|acknowledged)["']?)\s*:/u
/** `<Worker: celery@worker-1 (online)>` */
const WORKER_REPR = /<Worker:\s*(?<name>[\w.@:-]+)\s*\((?<status>[^)]*)\)>/u
/** `concurrency: 8` / `    . transport: redis://...` */
/** A `key: value` row in a stats dump; the key may be quoted JSON. */
const FACT = /^[.\s]*(?<key>["']?[A-Za-z][\w -]*["']?)\s*:\s*(?<value>.+)$/u
/** `-> celery@worker-1: OK` / `1 node online.` */
const COUNT_LINE = /^(?<count>\d+)\s+nodes?\s+(?<state>online|offline)\.?$/iu

/**
 * Parse Celery inspect / worker report text.
 * @param text - report text, already decoded.
 */
export function parseCeleryReport(text: string): CeleryReport {
  const lines = numberedLines(text)
  const ledger = new CoverageLedger()
  for (const line of lines) ledger.see(line.number, line.text)

  const warnings: string[] = []
  const workers: CeleryWorker[] = []
  const workerNames: string[] = []
  const activeTasks: string[] = []
  const reservedTasks: string[] = []
  const facts: CeleryFact[] = []
  let active: CeleryWorker | null = null
  let lastNode: string | null = null
  let lastNodeLine = 0
  let inTask = false
  let section: 'none' | 'active' | 'reserved' = 'none'
  let bannerCount = 0

  const noteWorker = (name: string): void => {
    if (!workerNames.includes(name)) workerNames.push(name)
  }

  /** The worker entry for the node block currently being read, if it has tasks. */
  const workerFor = (): CeleryWorker => {
    if (active !== null && active.name === lastNode) return active
    const created: CeleryWorker = { name: lastNode ?? '', tasks: [], task_count: 0, line: lastNodeLine }
    workers.push(created)
    active = created
    return created
  }

  for (const { number, text: raw } of lines) {
    const line = raw.replace(ANSI, '').replace(/\s+$/u, '')
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    const ping = PING_LINE.exec(trimmed)
    if (ping !== null) {
      const name = ping.groups?.name ?? ''
      noteWorker(name)
      // The trailing `1 node online.` summary is a count, not a worker.
      lastNode = name
      lastNodeLine = number
      active = null
      inTask = false
      ledger.recognize(number)
      continue
    }

    if (EMPTY_MARKER.test(trimmed)) {
      inTask = false
      ledger.recognize(number)
      continue
    }

    const countLine = COUNT_LINE.exec(trimmed)
    if (countLine !== null) {
      facts.push({ key: `nodes_${(countLine.groups?.state ?? '').toLowerCase()}`, value: countLine.groups?.count ?? '0', line: number })
      ledger.recognize(number)
      continue
    }

    const workerRepr = WORKER_REPR.exec(trimmed)
    if (workerRepr !== null) {
      noteWorker(workerRepr.groups?.name ?? '')
      ledger.recognize(number)
      continue
    }

    const nodeHeader = NODE_HEADER.exec(trimmed)
    if (nodeHeader !== null) {
      const name = nodeHeader.groups?.name ?? ''
      lastNode = name
      lastNodeLine = number
      active = null
      inTask = false
      noteWorker(name)
      section = 'active'
      ledger.recognize(number)
      continue
    }

    if (/^['"]?reserved['"]?\s*:/iu.test(trimmed)) {
      section = 'reserved'
      inTask = false
      ledger.recognize(number)
      continue
    }
    if (/^['"]?active['"]?\s*:/iu.test(trimmed)) {
      section = 'active'
      inTask = false
      ledger.recognize(number)
      continue
    }

    const taskName = TASK_NAME.exec(trimmed)
    if (taskName !== null) {
      const name = taskName.groups?.task ?? ''
      if (name.length > 0) {
        if (section === 'reserved') {
          reservedTasks.push(name)
        } else {
          activeTasks.push(name)
          const worker = lastNode === null ? null : workerFor()
          if (worker !== null) {
            worker.tasks.push(name)
            worker.task_count += 1
          }
        }
      }
      inTask = true
      ledger.recognize(number)
      continue
    }

    if (inTask && TASK_FIELD.test(trimmed)) {
      // `id:`, `args:`, `kwargs:`, `worker_pid:` and friends belong to the task
      // entry above them, not to the report's fact list.
      ledger.consume(number)
      continue
    }

    const fact = FACT.exec(trimmed)
    if (fact !== null && !trimmed.startsWith('->')) {
      inTask = false
      const key = (fact.groups?.key ?? '').trim().replace(/^["']|["']$/gu, '').toLowerCase().replace(/[\s-]+/gu, '_')
      const value = (fact.groups?.value ?? '').trim()
      if (value.endsWith('{') || value.endsWith('[')) {
        if (/celery@/u.test(value)) {
          // Structural opener such as `celery@worker-1: {`; the quoted form is
          // handled by the node-header rule above.
          noteWorker(value.replace(/[{[]\s*$/u, '').trim())
          ledger.recognize(number)
          continue
        }
        // A nested `"pool": {` opener carries no scalar fact, so it is read as a
        // structure line rather than reported as a fact with a brace value.
        ledger.recognize(number)
        continue
      }
      facts.push({ key, value, line: number })
      ledger.recognize(number)
      continue
    }

    if (/^(--------------|celery|software|platform|transport|results|concurrency|queues|tasks|events|uptime|pid|hostname|version)/iu.test(trimmed)) {
      bannerCount += 1
      ledger.consume(number)
      continue
    }

    ledger.reject(number)
  }

  const histogram = new Map<string, number>()
  for (const task of activeTasks) histogram.set(task, (histogram.get(task) ?? 0) + 1)
  const taskHistogram = [...histogram.entries()]
    .map(([task, count]) => ({ task, count }))
    .sort((left, right) => right.count - left.count || left.task.localeCompare(right.task))

  if (workers.length === 0) {
    warnings.push('no worker block was recognized; expected `celery@node: {` inspect output or `<Worker: celery@node (online)>` reports')
  }
  if (activeTasks.length === 0 && reservedTasks.length === 0) {
    warnings.push('no task entries were recognized; `-A` inspect output only lists tasks when the worker is busy or when `reserved` was requested')
  }
  if (bannerCount > 0) warnings.push(`${bannerCount} banner line(s) were recognized and skipped`)

  return {
    workers,
    worker_names: workerNames,
    active_task_count: activeTasks.length,
    active_tasks: activeTasks,
    task_histogram: taskHistogram,
    reserved_tasks: reservedTasks,
    facts,
    warnings,
    coverage: ledger.coverage(CELERY_PARSER_VERSION),
  }
}
