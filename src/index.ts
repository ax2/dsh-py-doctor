/**
 * dsh-py-doctor — deterministic, offline Python/Django production-report
 * diagnostics for DeepSeek Harness.
 *
 * Registers a family of report parsers for the artefacts a Python team actually
 * pastes into a chat: CPython tracebacks, pytest runs, `manage.py
 * showmigrations`, logged SQL, `manage.py check`, and Celery inspect output.
 * Every tool is a pure function of its input: no Python execution, no
 * subprocesses, no filesystem, no network, no clock, no randomness. Every result
 * carries byte accounting, an explicit coverage receipt, and an explicit refusal
 * when the input exceeds its budget.
 * @module dsh-py-doctor
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveLimits } from './limits.ts'
import { createTools } from './tools.ts'

export const name = 'py-doctor'

/** Requires the tool registry before `apply` runs. */
export const inject = ['tools']

export { Config }
export type { Config as PyDoctorConfig } from './limits.ts'
export { resolveLimits, DEFAULT_LIMITS } from './limits.ts'
export type { Limits } from './limits.ts'
export { createTools, defineReceiptTool, compileParameters } from './tools.ts'
export type { ToolBody, ToolFactoryOptions, ToolGroup } from './tools.ts'

/**
 * Register every enabled tool. Registration is effect-based, so unloading the
 * plugin unregisters the tools.
 * @param ctx - plugin context.
 * @param config - user configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = resolveLimits(config)
  const only = config.only ?? []
  const prefix = config.toolPrefix ?? ''
  for (const definition of createTools({ limits, prefix, only })) {
    ctx.tools.register(definition)
  }
}
