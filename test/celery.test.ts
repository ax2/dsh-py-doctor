/**
 * Celery inspect report tests, using verbatim `celery -A proj inspect ...` output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCeleryReport } from '../src/core/celery.ts'

/** Verbatim `celery -A shop inspect active` output for two workers. */
const ACTIVE = [
  '-> celery@worker-1: OK', // 1
  '    - empty -', // 2
  '-> celery@worker-2: OK', // 3
  '    * name: shop.tasks.send_invoice', // 4
  '      id: 8f4b4b1e-0f0d-4a5e-9d5f-2f1c4a7b0e11', // 5
  '      args: [42]', // 6
  '      kwargs: {}', // 7
  '      worker_pid: 118', // 8
  '    * name: shop.tasks.send_invoice', // 9
  '      id: 9a1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d', // 10
  '      args: [43]', // 11
  '      worker_pid: 119', // 12
].join('\n')

test('celery_report reads the busy workers, their tasks and the histogram', () => {
  const report = parseCeleryReport(ACTIVE)
  assert.deepEqual(report.worker_names, ['celery@worker-1', 'celery@worker-2'])
  // Only `worker-2` printed a task list; `worker-1` answered `- empty -`.
  assert.equal(report.workers.length, 1)
  assert.deepEqual(report.workers[0], {
    name: 'celery@worker-2',
    tasks: ['shop.tasks.send_invoice', 'shop.tasks.send_invoice'],
    task_count: 2,
    line: 3,
  })
  assert.equal(report.active_task_count, 2)
  assert.deepEqual(report.active_tasks, ['shop.tasks.send_invoice', 'shop.tasks.send_invoice'])
  assert.deepEqual(report.task_histogram, [{ task: 'shop.tasks.send_invoice', count: 2 }])
  assert.deepEqual(report.reserved_tasks, [])
  assert.equal(report.coverage.confidence, 1)
  assert.equal(report.coverage.parser_version, 'celery-1')
  assert.deepEqual(report.warnings, [])
})

test('celery_report reads a `celery inspect stats` fact block', () => {
  const stats = [
    '->  celery@worker-2: OK', // 1
    '{', // 2
    '    "worker_count": 1,', // 3
    '    "pool": {', // 4
    '        "max-concurrency": 8', // 5
    '    },', // 6
    '    "total": {', // 7
    '    }', // 8
    '}', // 9
    '2 nodes online.', // 10
  ].join('\n')

  const report = parseCeleryReport(stats)
  assert.deepEqual(report.worker_names, ['celery@worker-2'])
  assert.deepEqual(report.facts, [
    { key: 'worker_count', value: '1,', line: 3 },
    { key: 'max_concurrency', value: '8', line: 5 },
    { key: 'nodes_online', value: '2', line: 10 },
  ])
  // The bare braces are structure the parser does not interpret, so they are
  // reported as unread instead of being counted as facts.
  assert.equal(report.coverage.total_lines, 10)
  assert.equal(report.coverage.unknown_count, 4)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [2, 6, 8, 9],
  )
  assert.equal(report.coverage.parsed_lines, 6)
  assert.equal(report.coverage.confidence, 0.6)
})

test('celery_report separates an explicit reserved section from active tasks', () => {
  const reserved = [
    '-> celery@worker-1: OK', // 1
    '    * name: shop.tasks.send_invoice', // 2
    "'reserved': [", // 3
    "    {'name': 'shop.tasks.rebuild_index', 'id': 'abc'},", // 4
    ']', // 5
  ].join('\n')

  const report = parseCeleryReport(reserved)
  assert.deepEqual(report.active_tasks, ['shop.tasks.send_invoice'])
  assert.deepEqual(report.reserved_tasks, ['shop.tasks.rebuild_index'])
  assert.equal(report.active_task_count, 1)
  assert.equal(report.workers.length, 1)
  assert.deepEqual(report.workers[0]?.tasks, ['shop.tasks.send_invoice'])
  assert.equal(report.coverage.unknown_count, 1)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [5],
  )
})

test('celery_report reads a ping listing and worker reprs', () => {
  const ping = [
    '-> celery@worker-1: OK',
    '-> celery@worker-2: OK',
    '-> celery@worker-3: offline',
    '<Worker: celery@worker-1 (online)>',
  ].join('\n')

  const report = parseCeleryReport(ping)
  assert.deepEqual(report.worker_names, ['celery@worker-1', 'celery@worker-2', 'celery@worker-3'])
  assert.deepEqual(report.workers, [])
  assert.equal(report.active_task_count, 0)
  assert.ok(report.warnings.some((warning) => /no worker block/.test(warning)))
  assert.ok(report.warnings.some((warning) => /no task entries/.test(warning)))
  assert.equal(report.coverage.confidence, 1)
})

test('celery_report reads a long task list without dropping entries', () => {
  const lines = ['-> celery@worker-1: OK']
  for (let index = 0; index < 30; index += 1) {
    lines.push(`    * name: shop.tasks.task_${index}`)
    lines.push(`      id: ${index}`)
  }
  const report = parseCeleryReport(lines.join('\n'))
  assert.equal(report.active_task_count, 30)
  assert.equal(report.workers[0]?.task_count, 30)
  assert.equal(report.task_histogram.length, 30)
  assert.equal(report.task_histogram[0]?.count, 1)
  assert.equal(report.task_histogram[0]?.task, 'shop.tasks.task_0')
  assert.equal(report.warnings.length, 0)
})

test('a garbled celery paste is reported as unrecognized, never guessed', () => {
  const garbled = [
    '-> celery@worker-1: OK',
    '    * name: shop.tasks.send_invoice',
    '<<< the rest of the output was lost >>>',
  ].join('\n')

  const report = parseCeleryReport(garbled)
  assert.deepEqual(report.active_tasks, ['shop.tasks.send_invoice'])
  assert.equal(report.coverage.total_lines, 3)
  assert.equal(report.coverage.parsed_lines, 2)
  assert.equal(report.coverage.unknown_count, 1)
  assert.equal(report.coverage.confidence, 0.667)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [3],
  )
})

test('an empty paste yields an honest empty report', () => {
  const report = parseCeleryReport('')
  assert.deepEqual(report.workers, [])
  assert.deepEqual(report.worker_names, [])
  assert.equal(report.active_task_count, 0)
  assert.deepEqual(report.facts, [])
  assert.equal(report.coverage.total_lines, 0)
  assert.equal(report.coverage.confidence, 1)
  assert.ok(report.warnings.some((warning) => /no worker block/.test(warning)))
})
