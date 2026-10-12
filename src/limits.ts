/**
 * Plugin configuration and the per-call budgets derived from it.
 * @module dsh-py-doctor/limits
 */
import z from '@deepseek-ai/schemastery'

/** Effective budgets for one plugin instance. */
export interface Limits {
  /** Hard ceiling on a structured input payload, in UTF-8 bytes. */
  maxInputBytes: number
  /** Soft ceiling on a rendered result, in UTF-8 bytes. */
  maxOutputBytes: number
  /** Ceiling on traceback frames kept across all exception blocks. */
  maxFrames: number
  /** Ceiling on failure/error sections kept per pytest report. */
  maxFailures: number
  /** Ceiling on findings kept per `manage.py check` report. */
  maxFindings: number
  /** Ceiling on distinct normalized SQL statements returned. */
  maxQueryGroups: number
  /** Ceiling on tasks kept in a Celery task histogram. */
  maxTaskEntries: number
  /** Repetition threshold used by `django_sql_n_plus_one` when none is passed. */
  minRepeats: number
}

/** Default budgets: generous enough for one pasted report, small enough to stay bounded. */
export const DEFAULT_LIMITS: Limits = {
  maxInputBytes: 262_144,
  maxOutputBytes: 262_144,
  maxFrames: 200,
  maxFailures: 100,
  maxFindings: 200,
  maxQueryGroups: 500,
  maxTaskEntries: 500,
  minRepeats: 3,
}

/** User-facing configuration. */
export interface Config {
  /** Hard ceiling on a structured input payload, in UTF-8 bytes. */
  maxInputBytes?: number
  /** Soft ceiling on a rendered result, in UTF-8 bytes. */
  maxOutputBytes?: number
  /** Ceiling on traceback frames kept across all exception blocks. */
  maxFrames?: number
  /** Ceiling on failure/error sections kept per pytest report. */
  maxFailures?: number
  /** Ceiling on findings kept per `manage.py check` report. */
  maxFindings?: number
  /** Ceiling on distinct normalized SQL statements returned. */
  maxQueryGroups?: number
  /** Ceiling on tasks kept in a Celery task histogram. */
  maxTaskEntries?: number
  /** Repetition threshold used by `django_sql_n_plus_one` when none is passed. */
  minRepeats?: number
  /** Tool-name prefix, e.g. `py` yields `py__python_traceback`. Empty by default. */
  toolPrefix?: string
  /** Register only these tool names (empty or omitted registers every tool). */
  only?: string[]
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxInputBytes: z.natural().default(262_144).description('Hard ceiling on structured input, in UTF-8 bytes.'),
  maxOutputBytes: z.natural().default(262_144).description('Soft ceiling on rendered results, in UTF-8 bytes.'),
  maxFrames: z.natural().default(200).description('Ceiling on traceback frames kept across all exception blocks.'),
  maxFailures: z.natural().default(100).description('Ceiling on pytest failure and error sections kept.'),
  maxFindings: z.natural().default(200).description('Ceiling on `manage.py check` findings kept.'),
  maxQueryGroups: z.natural().default(500).description('Ceiling on distinct normalized SQL statements returned.'),
  maxTaskEntries: z.natural().default(500).description('Ceiling on Celery task histogram entries returned.'),
  minRepeats: z.natural().default(3).description('Default repetition threshold for N+1 candidate detection.'),
  toolPrefix: z.string().default('').description('Optional prefix for registered tool names.'),
  only: z.array(z.string()).default([]).description('Register only these tool names; empty registers every tool.'),
})

/**
 * Merge user configuration over the defaults.
 * @param config - user configuration, possibly empty.
 */
export function resolveLimits(config: Config = {}): Limits {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  return {
    maxInputBytes: pick(config.maxInputBytes, DEFAULT_LIMITS.maxInputBytes),
    maxOutputBytes: pick(config.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
    maxFrames: pick(config.maxFrames, DEFAULT_LIMITS.maxFrames),
    maxFailures: pick(config.maxFailures, DEFAULT_LIMITS.maxFailures),
    maxFindings: pick(config.maxFindings, DEFAULT_LIMITS.maxFindings),
    maxQueryGroups: pick(config.maxQueryGroups, DEFAULT_LIMITS.maxQueryGroups),
    maxTaskEntries: pick(config.maxTaskEntries, DEFAULT_LIMITS.maxTaskEntries),
    minRepeats: pick(config.minRepeats, DEFAULT_LIMITS.minRepeats),
  }
}
