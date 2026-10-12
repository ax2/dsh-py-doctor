/**
 * `python manage.py showmigrations` parser.
 *
 * Django prints one block per app. There are two shapes in the wild: the default
 * indented list (`app` then ` [X] 0001_initial`), and the flat list produced by
 * `--plan`, where the app label sits alone on its own line and the markers follow
 * unindented. `--database` runs print a third banner shape. All three are read;
 * anything else lands in the coverage receipt.
 * @module dsh-py-doctor/core/migrations
 */
import { numberedLines } from './bytes.ts'
import { CoverageLedger, type Coverage } from './coverage.ts'

/** Grammar revision of {@link parseDjangoMigrations}. */
export const MIGRATIONS_PARSER_VERSION = 'migrations-1'

/** One migration line. */
export interface MigrationEntry {
  /** Migration name, e.g. `0003_alter_order_total`. */
  name: string
  /** `true` for `[X]`, `false` for `[ ]`. */
  applied: boolean
  /** 1-based line the entry was printed on. */
  line: number
}

/** One app block. */
export interface MigrationApp {
  /** App label as printed. */
  app: string
  /** `true` when the app printed `(no migrations)`. */
  no_migrations: boolean
  /** Migration names already applied. */
  applied: string[]
  /** Migration names not yet applied. */
  unapplied: string[]
  /** Number of applied migrations (`[X]`). */
  applied_count: number
  /** Number of unapplied migrations (`[ ]`). */
  unapplied_count: number
  /** Every entry in print order. */
  migrations: MigrationEntry[]
  /** Database section this app block belonged to, when the report had several. */
  database: string | null
}

/** Result of {@link parseDjangoMigrations}. */
export interface MigrationsReport {
  /** App blocks in print order. */
  apps: MigrationApp[]
  /** App labels with at least one unapplied migration. */
  apps_with_unapplied: string[]
  /** App labels that printed `(no migrations)`. */
  apps_with_no_migrations: string[]
  /** Apps that carry at least one migration line or an explicit `(no migrations)`. */
  total_apps: number
  /** Applied migration lines across every app. */
  applied_total: number
  /** Unapplied migration lines across every app. */
  unapplied_total: number
  /** `true` when at least one migration is unapplied. */
  plan_needed: boolean
  /** Database names mentioned in the report, in print order. */
  databases: string[]
  /** Non-fatal problems worth telling the model about. */
  warnings: string[]
  /** Coverage receipt for this parse. */
  coverage: Coverage
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu
/**
 * `manage.py showmigrations` indents each marker with a single leading space;
 * `migrate --plan` indents by four. Both are accepted.
 */
const INDENTED_MARKED = /^[ \t]+\[(?<mark>[X ])\]\s*(?<name>\S+)\s*$/u
const FLAT_MARKED = /^\[(?<mark>[X ])\]\s*(?<name>\S+)\s*$/u
const NO_MIGRATIONS = /^(?<app>[A-Za-z_][\w.]*) \(no migrations\)$/u
/**
 * Django prints `(no migrations)` on its own indented line under the app label,
 * and some versions print `app (no migrations)` on one line. Both are read.
 */
const BARE_NO_MIGRATIONS = /^[ \t]*\(no migrations\)\s*$/u
const DATABASE_HEADER = /^(?<app>[A-Za-z_][\w.]*) \((?<database>[^()]+)\)$/u
const APP_LABEL = /^[A-Za-z_][\w.]*$/u
const BANNER = /^(No migrations to apply|Running migrations|Operations to perform|Applying all migrations)/u

/**
 * Parse `manage.py showmigrations` output.
 * @param text - report text, already decoded.
 */
export function parseDjangoMigrations(text: string): MigrationsReport {
  const lines = numberedLines(text)
  const ledger = new CoverageLedger()
  for (const line of lines) ledger.see(line.number, line.text)

  // A bare `app` line is only a header when at least one indented marker follows
  // it before the next unindented line — otherwise it is prose.
  const hasIndentedChild = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    const entry = lines[index]
    if (entry === undefined) continue
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]
      if (candidate === undefined) break
      if (candidate.text.trim().length === 0) continue
      if (INDENTED_MARKED.test(candidate.text) || BARE_NO_MIGRATIONS.test(candidate.text)) {
        hasIndentedChild.add(entry.number)
        break
      }
      if (/^[ \t]+/u.test(candidate.text)) continue
      break
    }
  }

  const warnings: string[] = []
  const apps: MigrationApp[] = []
  const byKey = new Map<string, MigrationApp>()
  const databases: string[] = []
  let currentApp: MigrationApp | null = null
  let currentDatabase: string | null = null
  let lastAppLabel: string | null = null
  let bannerCount = 0

  const appFor = (app: string): MigrationApp => {
    const key = currentDatabase === null ? app : `${currentDatabase}\u0000${app}`
    const existing = byKey.get(key)
    if (existing !== undefined) return existing
    const created: MigrationApp = {
      app,
      no_migrations: false,
      applied: [],
      unapplied: [],
      applied_count: 0,
      unapplied_count: 0,
      migrations: [],
      database: currentDatabase,
    }
    byKey.set(key, created)
    apps.push(created)
    return created
  }

  const record = (app: MigrationApp, name: string, applied: boolean, line: number): void => {
    app.migrations.push({ name, applied, line })
    if (applied) {
      app.applied.push(name)
      app.applied_count += 1
    } else {
      app.unapplied.push(name)
      app.unapplied_count += 1
    }
  }

  for (const { number, text: raw } of lines) {
    const line = raw.replace(ANSI, '').replace(/\s+$/u, '')
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    const indented = INDENTED_MARKED.exec(line)
    if (indented !== null) {
      const app = currentApp
      if (app === null) {
        warnings.push(`line ${number}: migration marker printed before any app header`)
        ledger.reject(number)
        continue
      }
      record(app, indented.groups?.name ?? '', indented.groups?.mark === 'X', number)
      ledger.recognize(number)
      continue
    }

    const flat = FLAT_MARKED.exec(line)
    if (flat !== null) {
      const app = currentApp
      if (app === null) {
        warnings.push(`line ${number}: flat \`[X] name\` entry printed before any app header`)
        ledger.reject(number)
        continue
      }
      record(app, flat.groups?.name ?? '', flat.groups?.mark === 'X', number)
      ledger.recognize(number)
      continue
    }

    const noMigrations = NO_MIGRATIONS.exec(trimmed)
    if (noMigrations !== null) {
      const label = noMigrations.groups?.app ?? ''
      currentApp = appFor(label)
      currentApp.no_migrations = true
      lastAppLabel = label
      ledger.recognize(number)
      continue
    }

    if (BARE_NO_MIGRATIONS.test(line)) {
      // `(no migrations)` belongs to the app label printed directly above it.
      const label = lastAppLabel
      if (label === null) {
        warnings.push(`line ${number}: '(no migrations)' printed before any app header`)
        ledger.reject(number)
        continue
      }
      const app = appFor(label)
      app.no_migrations = true
      currentApp = app
      ledger.recognize(number)
      continue
    }

    const databaseHeader = DATABASE_HEADER.exec(trimmed)
    if (databaseHeader !== null) {
      const name = databaseHeader.groups?.database ?? ''
      // `app (no migrations)` was handled above; a bare `default (no migrations)`
      // style banner is not a database section.
      if (name.startsWith('no migrations')) {
        currentApp = appFor(databaseHeader.groups?.app ?? '')
        currentApp.no_migrations = true
        lastAppLabel = databaseHeader.groups?.app ?? ''
        ledger.recognize(number)
        continue
      }
      currentDatabase = name
      if (!databases.includes(name)) databases.push(name)
      const label = databaseHeader.groups?.app ?? ''
      currentApp = label.length > 0 ? appFor(label) : null
      lastAppLabel = label.length > 0 ? label : null
      ledger.recognize(number)
      continue
    }

    if (APP_LABEL.test(trimmed) && hasIndentedChild.has(number)) {
      currentApp = appFor(trimmed)
      lastAppLabel = trimmed
      ledger.recognize(number)
      continue
    }

    if (BANNER.test(trimmed)) {
      bannerCount += 1
      ledger.consume(number)
      continue
    }

    // In a flat `--plan` report the app label precedes unindented markers; accept
    // it when the next non-blank line is a flat marker.
    if (APP_LABEL.test(trimmed)) {
      const next = lines.find((candidate) => candidate.number > number && candidate.text.trim().length > 0)
      if (next !== undefined && FLAT_MARKED.test(next.text)) {
        currentApp = appFor(trimmed)
        lastAppLabel = trimmed
        ledger.recognize(number)
        continue
      }
    }

    ledger.reject(number)
  }

  for (const app of apps) {
    if (app.migrations.length === 0 && !app.no_migrations) {
      warnings.push(`app '${app.app}' printed no migration lines; its state is unknown`)
    }
  }
  if (apps.length === 0) {
    warnings.push('no app blocks found; this input does not look like `manage.py showmigrations` output')
  }
  if (bannerCount > 0) warnings.push(`${bannerCount} surrounding command line(s) were recognized and skipped`)

  const appliedTotal = apps.reduce((sum, app) => sum + app.applied_count, 0)
  const unappliedTotal = apps.reduce((sum, app) => sum + app.unapplied_count, 0)

  return {
    apps,
    apps_with_unapplied: apps.filter((app) => app.unapplied_count > 0).map((app) => app.app),
    apps_with_no_migrations: apps.filter((app) => app.no_migrations).map((app) => app.app),
    total_apps: apps.filter((app) => app.migrations.length > 0 || app.no_migrations).length,
    applied_total: appliedTotal,
    unapplied_total: unappliedTotal,
    plan_needed: unappliedTotal > 0,
    databases,
    warnings,
    coverage: ledger.coverage(MIGRATIONS_PARSER_VERSION),
  }
}
