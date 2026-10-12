/**
 * Tool-level tests: the assembled definitions, their schemas, the receipt they
 * return through `execute`/`render`, the input budget refusal, and the
 * `prefix`/`only` instance options.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools, defineReceiptTool, compileParameters } from '../src/tools.ts'
import { DEFAULT_LIMITS, Config, resolveLimits } from '../src/limits.ts'
import * as entry from '../src/index.ts'

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/srv/app/shop/views.py", line 12, in post',
  '    return self.helper(request)',
  '  File "/usr/local/lib/python3.12/site-packages/django/db/models/query.py", line 448, in get',
  '    raise self.model.DoesNotExist(',
  'shop.models.Order.DoesNotExist: Order matching query does not exist.',
].join('\n')

const TOOL_NAMES = [
  'python_traceback',
  'pytest_summary',
  'django_migrations',
  'django_sql_n_plus_one',
  'django_checks',
  'celery_report',
]

/** Execute one tool the way the host does, including the render step. */
async function call(name: string, args: Record<string, unknown>): Promise<{ value: unknown; blocks: { type: string; text: string }[] }> {
  const tools = createTools({ limits: DEFAULT_LIMITS })
  const definition = tools.find((candidate) => candidate?.name === name)
  assert.ok(definition !== undefined, `tool ${name} was not registered`)
  const value = await definition.execute(args, { signal: new AbortController().signal } as never)
  const blocks = definition.output.render({}, value as never) as { type: string; text: string }[]
  return { value, blocks }
}

test('the plugin registers every tool with a unique name in the python group', () => {
  const tools = createTools({ limits: DEFAULT_LIMITS })
  assert.equal(tools.length, TOOL_NAMES.length)
  assert.deepEqual(
    tools.map((tool) => tool?.name),
    TOOL_NAMES,
  )
  assert.equal(new Set(tools.map((tool) => tool?.name)).size, TOOL_NAMES.length)
  for (const tool of tools) {
    assert.ok(tool !== undefined)
    assert.ok(tool.description.includes('Refuses') || tool.description.includes('refused'))
  }
})

test('every tool schema is a valid closed object exposing text and the receipt', () => {
  const tools = createTools({ limits: DEFAULT_LIMITS })
  for (const tool of tools) {
    assert.ok(tool !== undefined)
    // `defineTool` compiles the parameter DSL at definition time, so the
    // definition carries JSON Schema already.
    const input = tool.parameters as {
      type: string
      properties: Record<string, { type: string; description?: string }>
      required?: string[]
      additionalProperties?: boolean
    }
    assert.equal(input.type, 'object')
    assert.equal(input.properties.text?.type, 'string')
    assert.ok((input.properties.text?.description ?? '').length > 40)
    assert.deepEqual(input.required, ['text'])

    const output = tool.output.schema as {
      type?: string
      properties: Record<string, { type?: string }>
      additionalProperties?: boolean
    }
    assert.equal(output.type, 'object')
    assert.deepEqual(Object.keys(output.properties).sort(), ['meta', 'result'])
    assert.equal(output.additionalProperties, false)
  }
})

test('the parameter DSL compiles to JSON Schema with required flags preserved', () => {
  const compiled = compileParameters({ text: { type: 'string', required: true }, min_repeats: { type: 'integer' } }) as {
    type: string
    properties: Record<string, { type: string }>
    required: string[]
    additionalProperties?: boolean
  }
  assert.equal(compiled.type, 'object')
  assert.deepEqual(Object.keys(compiled.properties), ['text', 'min_repeats'])
  assert.deepEqual(compiled.required, ['text'])
  // An unsupported node is refused with the offending path, not coerced.
  assert.throws(() => compileParameters({ text: { type: 'nonsense' } } as never))
})

test('the entry module registers through apply() and exports no default', () => {
  assert.equal(entry.name, 'py-doctor')
  assert.deepEqual(entry.inject, ['tools'])
  assert.equal(Object.hasOwn(entry, 'default'), false)

  const registered: { name: string }[] = []
  const ctx = { tools: { register: (tool: { name: string }) => registered.push(tool) } }
  entry.apply(ctx as never, {})
  assert.deepEqual(
    registered.map((tool) => tool.name),
    TOOL_NAMES,
  )
})

test('python_traceback returns a receipt envelope through execute and render', async () => {
  const { value, blocks } = await call('python_traceback', { text: TRACEBACK })
  const envelope = value as {
    result: { exception_type: string; frames: unknown[]; deepest_project_frame: { function: string } | null; coverage: { confidence: number } }
    meta: { bytesIn: number; bytesOut: number; truncated: boolean; notes: string[] }
  }
  assert.equal(envelope.result.exception_type, 'DoesNotExist')
  assert.equal(envelope.result.frames.length, 2)
  assert.equal(envelope.result.deepest_project_frame?.function, 'post')
  assert.equal(envelope.meta.bytesIn, Buffer.byteLength(TRACEBACK, 'utf8'))
  assert.ok(envelope.meta.bytesOut > 0)
  assert.equal(envelope.meta.truncated, false)
  assert.ok(envelope.meta.notes[0]?.startsWith('parse coverage 100.0%'))
  // The rendered block is the payload, plus the coverage note the receipt carries.
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.text, `${JSON.stringify(envelope.result, null, 2)}\n\n[note] ${envelope.meta.notes[0]}`)
})

test('every tool answers its own report family end to end', async () => {
  const pytest = await call('pytest_summary', { text: '2 passed, 1 failed in 0.42s\n' })
  assert.equal((pytest.value as { result: { counts: { passed: number } } }).result.counts.passed, 2)

  const migrations = await call('django_migrations', { text: 'shop\n [X] 0001_initial\n [ ] 0002_x\n' })
  assert.equal((migrations.value as { result: { unapplied_total: number } }).result.unapplied_total, 1)

  const sql = await call('django_sql_n_plus_one', {
    text: ['SELECT "a" FROM "t" WHERE "t"."id" = 1', 'SELECT "a" FROM "t" WHERE "t"."id" = 2', 'SELECT "a" FROM "t" WHERE "t"."id" = 3'].join('\n'),
  })
  assert.equal((sql.value as { result: { candidates: unknown[] } }).result.candidates.length, 1)

  const checks = await call('django_checks', { text: 'System check identified no issues (0 silenced).\n' })
  assert.equal((checks.value as { result: { clean: boolean } }).result.clean, true)

  const celery = await call('celery_report', { text: '-> celery@worker-1: OK\n    - empty -\n' })
  assert.deepEqual((celery.value as { result: { worker_names: string[] } }).result.worker_names, ['celery@worker-1'])
})

test('every tool reports an honest empty report for an empty paste', async () => {
  const tools = createTools({ limits: DEFAULT_LIMITS })
  const parsers: Record<string, string> = {
    python_traceback: 'tb-1',
    pytest_summary: 'pytest-1',
    django_migrations: 'migrations-1',
    django_sql_n_plus_one: 'sql-1',
    django_checks: 'checks-1',
    celery_report: 'celery-1',
  }
  for (const tool of tools) {
    assert.ok(tool !== undefined)
    const value = (await tool.execute({ text: '' }, { signal: new AbortController().signal } as never)) as {
      result: { coverage: { total_lines: number; parsed_lines: number; unknown_count: number; confidence: number; parser_version: string } }
      meta: { bytesIn: number; truncated: boolean; notes: string[] }
    }
    assert.equal(value.meta.bytesIn, 0, tool.name)
    assert.equal(value.meta.truncated, false, tool.name)
    assert.equal(value.result.coverage.total_lines, 0, tool.name)
    assert.equal(value.result.coverage.parsed_lines, 0, tool.name)
    assert.equal(value.result.coverage.unknown_count, 0, tool.name)
    assert.equal(value.result.coverage.confidence, 1, tool.name)
    assert.equal(value.result.coverage.parser_version, parsers[tool.name], tool.name)
  }
})

test('an over-budget input is refused, and no partial result is returned', async () => {
  const huge = 'x'.repeat(DEFAULT_LIMITS.maxInputBytes + 1)
  const tools = createTools({ limits: DEFAULT_LIMITS })
  for (const tool of tools) {
    assert.ok(tool !== undefined)
    await assert.rejects(
      async () => tool.execute({ text: huge }, { signal: new AbortController().signal } as never),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as { code?: string }).code, 'INPUT_TOO_LARGE')
        assert.ok(error.message.includes(String(DEFAULT_LIMITS.maxInputBytes)))
        return true
      },
    )
  }
})

test('an exactly-at-budget input is accepted', async () => {
  const payload = 'x'.repeat(DEFAULT_LIMITS.maxInputBytes)
  const { value } = await call('django_checks', { text: payload })
  const envelope = value as { meta: { bytesIn: number; truncated: boolean }; result: { coverage: { confidence: number } } }
  assert.equal(envelope.meta.bytesIn, DEFAULT_LIMITS.maxInputBytes)
  assert.equal(envelope.meta.truncated, false)
  // Prose is not a check report, so confidence collapses instead of being faked.
  assert.equal(envelope.result.coverage.confidence, 0)
})

test('an aborted call throws before doing any work', async () => {
  const tools = createTools({ limits: DEFAULT_LIMITS })
  const tool = tools[0]
  assert.ok(tool !== undefined)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(async () => tool.execute({ text: 'x' }, { signal: controller.signal } as never))
})

test('the frame cap bounds the result and says so', async () => {
  const frames = Array.from({ length: 12 }, (_unused, index) => [
    `  File "/srv/app/shop/step${index}.py", line ${index + 1}, in step${index}`,
    `    call_${index}()`,
  ]).join('\n')
  const text = `Traceback (most recent call last):\n${frames}\nRuntimeError: boom\n`
  const limits = { ...DEFAULT_LIMITS, maxFrames: 4 }
  const tools = createTools({ limits })
  const tool = tools.find((candidate) => candidate?.name === 'python_traceback')
  assert.ok(tool !== undefined)
  const value = (await tool.execute({ text }, { signal: new AbortController().signal } as never)) as {
    result: { frames: unknown[]; deepest_frame: unknown }
    meta: { truncated: boolean; notes: string[] }
  }
  assert.equal(value.result.frames.length, 4)
  assert.equal(value.meta.truncated, true)
  assert.ok(value.meta.notes.some((note) => /maxFrames=4/.test(note)))
  const blocks = tool.output.render({}, value as never) as { text: string }[]
  assert.ok(blocks[0]?.text.includes('[bounded]'))
})

test('the min_repeats option is clamped and reported', async () => {
  const text = [
    'SELECT "a" FROM "t" WHERE "t"."id" = 1',
    'SELECT "a" FROM "t" WHERE "t"."id" = 2',
  ].join('\n')
  const relaxed = await call('django_sql_n_plus_one', { text, min_repeats: 2 })
  assert.equal((relaxed.value as { result: { candidates: unknown[] } }).result.candidates.length, 1)
  assert.ok((relaxed.value as { meta: { notes: string[] } }).meta.notes.some((note) => /min_repeats=2/.test(note)))

  const ignored = await call('django_sql_n_plus_one', { text, min_repeats: 1 })
  assert.equal((ignored.value as { result: { min_repeats: number } }).result.min_repeats, 2)
  // The compiled parameter schema rejects a non-integer before the tool body runs.
  const tools = createTools({ limits: DEFAULT_LIMITS })
  const sqlTool = tools.find((candidate) => candidate?.name === 'django_sql_n_plus_one')
  assert.ok(sqlTool !== undefined)
  await assert.rejects(
    async () => sqlTool.execute({ text, min_repeats: 'lots' }, { signal: new AbortController().signal } as never),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
      return true
    },
  )
})

test('the tool list bounds every list-producing family', async () => {
  const failures = Array.from({ length: 30 }, (_unused, index) => `FAILED tests/test_x.py::test_${index} - boom`).join('\n')
  const text = `===== short test summary info =====\n${failures}\n30 failed in 1.00s\n`
  const limits = { ...DEFAULT_LIMITS, maxFailures: 5 }
  const tools = createTools({ limits })
  const tool = tools.find((candidate) => candidate?.name === 'pytest_summary')
  assert.ok(tool !== undefined)
  const value = (await tool.execute({ text }, { signal: new AbortController().signal } as never)) as {
    result: { failures: unknown[]; counts: { failed: number } }
    meta: { truncated: boolean; notes: string[] }
  }
  assert.equal(value.result.failures.length, 5)
  assert.equal(value.result.counts.failed, 30)
  assert.equal(value.meta.truncated, true)
  assert.ok(value.meta.notes.some((note) => /maxFailures=5/.test(note)))
})

test('prefix and only shape one plugin instance', async () => {
  const prefixed = createTools({ limits: DEFAULT_LIMITS, prefix: 'py' })
  assert.deepEqual(
    prefixed.map((tool) => tool?.name),
    TOOL_NAMES.map((name) => `py__${name}`),
  )

  const filtered = createTools({ limits: DEFAULT_LIMITS, only: ['django_checks', 'celery_report'] })
  assert.deepEqual(
    filtered.map((tool) => tool?.name),
    ['django_checks', 'celery_report'],
  )

  const empty = createTools({ limits: DEFAULT_LIMITS, only: [] })
  assert.equal(empty.length, TOOL_NAMES.length)

  const none = createTools({ limits: DEFAULT_LIMITS, only: ['not_a_tool'] })
  assert.deepEqual(none, [])

  const direct = defineReceiptTool(
    { name: 'python_traceback', group: 'python', description: 'x'.repeat(20), parameters: { text: TEXT }, result: { type: 'json' }, run: () => ({ result: {}, meta: { bytesIn: 0, bytesOut: 2, truncated: false, notes: [] } }) },
    { limits: DEFAULT_LIMITS, only: ['celery_report'] },
  )
  assert.equal(direct, undefined)
})

const TEXT = { type: 'string', required: true, description: 'x' } as const

test('resolveLimits falls back per field and keeps valid overrides', () => {
  assert.equal(resolveLimits(undefined).maxInputBytes, DEFAULT_LIMITS.maxInputBytes)
  assert.equal(resolveLimits({}).maxFrames, DEFAULT_LIMITS.maxFrames)
  const custom = resolveLimits({ maxInputBytes: 1024, maxFrames: 7 })
  assert.equal(custom.maxInputBytes, 1024)
  assert.equal(custom.maxFrames, 7)
  assert.equal(custom.maxFailures, DEFAULT_LIMITS.maxFailures)
  // Nonsense values cannot lower a budget to something unusable.
  const guarded = resolveLimits({ maxInputBytes: -5, maxFrames: Number.NaN })
  assert.ok(guarded.maxInputBytes > 0)
  assert.ok(guarded.maxFrames > 0)
})

test('the Config schema validates the shape apply() receives', () => {
  assert.equal(Config({}) !== undefined, true)
  const parsed = Config({ maxInputBytes: 2048, only: ['django_checks'] }) as { maxInputBytes: number; only: string[] }
  assert.equal(parsed.maxInputBytes, 2048)
  assert.deepEqual(parsed.only, ['django_checks'])
  assert.throws(() => Config({ maxInputBytes: 'big' } as never))
})

test('apply accepts a config object and registers the filtered set', () => {
  const registered: { name: string }[] = []
  const ctx = { tools: { register: (tool: { name: string }) => registered.push(tool) } }
  entry.apply(ctx as never, { toolPrefix: 'pyd', only: ['celery_report'] })
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['pyd__celery_report'],
  )

  const all: { name: string }[] = []
  entry.apply({ tools: { register: (tool: { name: string }) => all.push(tool) } } as never, { maxFrames: 3 })
  assert.deepEqual(
    all.map((tool) => tool.name),
    TOOL_NAMES,
  )
})
