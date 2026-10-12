/**
 * Traceback parser tests. The fixtures are the shapes CPython and Django
 * actually print, including ANSI colour, log prefixes, `SyntaxError` carets and
 * elided recursion; the garbled fixture asserts that coverage degrades honestly
 * instead of silently dropping lines.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOrigin, parsePythonTraceback } from '../src/core/traceback.ts'
import type { TracebackReport } from '../src/core/traceback.ts'

/** The separator line CPython prints for `raise ... from ...`. */
const DIRECT_CAUSE_LINE = 'The above exception was the direct cause of the following exception:'

/** Verbatim `python manage.py migrate` failure as printed by Django 4.2. */
const DJANGO_TRACEBACK = [
  '2026-10-12 09:14:22,481 INFO django.db.backends.base.commands Applying shop.0002_order_total...', // 1
  'Traceback (most recent call last):', // 2
  '  File "/srv/app/manage.py", line 22, in <module>', // 3
  '    main()', // 4
  '  File "/srv/app/shop/management/commands/migrate.py", line 41, in main', // 5
  '    run_migrations()', // 6
  '  File "/srv/app/shop/migrations/0002_order_total.py", line 17, in run_migrations', // 7
  '    schema_editor.add_field(Order, field)', // 8
  '  File "/usr/local/lib/python3.11/site-packages/django/db/backends/base/schema.py", line 1541, in add_field', // 9
  '    self.execute(sql)', // 10
  '  File "/usr/local/lib/python3.11/site-packages/django/db/backends/utils.py", line 89, in execute', // 11
  '    return self._execute_with_wrappers(sql, params, many=False, executor=self._execute)', // 12
  '  File "/usr/local/lib/python3.11/site-packages/django/db/backends/utils.py", line 98, in _execute_with_wrappers', // 13
  '    return executor(sql, params, many, context)', // 14
  'django.db.utils.OperationalError: no such table: shop_order_total', // 15
].join('\n')

test('python_traceback reads a Django migration failure frame by frame', () => {
  const report = parsePythonTraceback(DJANGO_TRACEBACK)
  assert.equal(report.exception_type, 'OperationalError')
  assert.equal(report.exception_module, 'django.db.utils')
  assert.equal(report.blocks.length, 1)
  assert.equal(report.exception_message, 'no such table: shop_order_total')
  assert.equal(report.chain.length, 1)
  assert.equal(report.frames.length, 6)
  assert.equal(report.deepest_frame?.function, '_execute_with_wrappers')
  assert.equal(report.deepest_frame?.file, '/usr/local/lib/python3.11/site-packages/django/db/backends/utils.py')
  assert.equal(report.deepest_frame?.line, 98)
  assert.equal(report.deepest_frame?.installed, true)
  assert.equal(report.deepest_frame?.origin, 'installed')
  assert.equal(report.deepest_project_frame?.function, 'run_migrations')
  assert.equal(report.deepest_project_frame?.line, 17)
  assert.equal(report.deepest_project_frame?.origin, 'project')
  assert.equal(report.frames.filter((frame) => frame.origin === 'project').length, 3)
  assert.equal(report.frames.filter((frame) => frame.origin === 'installed').length, 3)

  const hint = report.cause_hints[0]
  assert.equal(hint?.exception_type, 'OperationalError')
  assert.match(hint?.hint ?? '', /shop_order_total/)
  assert.equal(hint?.suggestions.length, 3)

  assert.equal(report.coverage.parser_version, 'tb-1')
  assert.equal(report.coverage.confidence, 1)
  assert.equal(report.coverage.unknown_count, 0)
  assert.deepEqual(report.coverage.unknown_lines, [])
})

test('python_traceback splits a chained cause and reports both types', () => {
  const text = [
    'Traceback (most recent call last):',
    '  File "/srv/app/config/celery.py", line 8, in <module>',
    '    from celery import Celery',
    "ModuleNotFoundError: No module named 'celery'",
    '',
    DIRECT_CAUSE_LINE,
    '',
    'Traceback (most recent call last):',
    '  File "/srv/app/config/settings.py", line 212, in <module>',
    '    from .celery import app as celery_app',
    '  File "/srv/app/config/celery.py", line 12, in <module>',
    '    app.config_from_object("django.conf:settings", namespace="CELERY")',
    'django.core.exceptions.ImproperlyConfigured: Cannot import Celery: is it installed?',
  ].join('\n')

  const report = parsePythonTraceback(text)
  assert.deepEqual(report.chain, ['ModuleNotFoundError', 'ImproperlyConfigured'])
  assert.equal(report.blocks.length, 2)
  assert.equal(report.blocks[0]?.chain, 'none')
  assert.equal(report.blocks[1]?.chain, 'direct_cause')
  assert.equal(report.blocks[0]?.exception_module, null)
  assert.equal(report.exception_type, 'ImproperlyConfigured')
  assert.equal(report.exception_module, 'django.core.exceptions')
  assert.equal(report.frames.length, 3)
  assert.equal(report.blocks[0]?.frames.length, 1)
  assert.equal(report.deepest_project_frame?.function, '<module>')
  assert.equal(report.deepest_frame?.line, 12)
  assert.equal(report.coverage.confidence, 1)
})

test('python_traceback reads a SyntaxError caret with its column', () => {
  const text = [
    'Traceback (most recent call last):',
    '  File "/srv/app/shop/views.py", line 31, in <module>',
    '    from . import utils',
    '  File "/srv/app/shop/utils.py", line 52',
    '    total = sum(item.price for item in items',
    '            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
    'SyntaxError: expected \')\'',
  ].join('\n')

  const report = parsePythonTraceback(text)
  assert.equal(report.exception_type, 'SyntaxError')
  assert.equal(report.blocks[0]?.syntax?.line_number, 52)
  assert.equal(report.blocks[0]?.syntax?.pointer_length, 34)
  assert.equal(report.blocks[0]?.syntax?.offset, 13)
  assert.equal(report.blocks[0]?.syntax?.left, 'total = sum(')
  assert.equal(report.blocks[0]?.syntax?.middle, 'item.price for item in items')
  assert.equal(report.blocks[0]?.syntax?.right, '')
  assert.equal(report.cause_hints[0]?.exception_type, 'SyntaxError')
  assert.match(report.cause_hints[0]?.hint ?? '', /column 13/)
  assert.equal(report.coverage.confidence, 1)
})

test('python_traceback records an elided recursion loop', () => {
  const text = [
    'Traceback (most recent call last):',
    '  File "/srv/app/shop/models.py", line 88, in to_dict',
    '    return {"customer": self.customer.to_dict()}',
    '  File "/srv/app/shop/models.py", line 88, in to_dict',
    '    return {"customer": self.customer.to_dict()}',
    '  [Previous line repeated 996 more times]',
    'RecursionError: maximum recursion depth exceeded',
  ].join('\n')

  const report = parsePythonTraceback(text)
  assert.equal(report.exception_type, 'RecursionError')
  assert.equal(report.frames.length, 2)
  // CPython attaches the elision marker to the frame it stopped repeating, which
  // is the last frame of the block.
  assert.equal(report.frames[0]?.repeated, 0)
  assert.equal(report.frames[1]?.repeated, 996)
  assert.equal(report.blocks[0]?.truncated, true)
  assert.match(report.cause_hints[0]?.hint ?? '', /to_dict x996/)
  assert.equal(report.coverage.confidence, 1)
})

test('python_traceback keeps ANSI colour, log prefixes and Time out of the payload', () => {
  const text = [
    '\u001b[31mInternal Server Error: /checkout/\u001b[0m',
    'Traceback (most recent call last):',
    '  File "/srv/app/shop/views.py", line 58, in post',
    '    coupon = Coupon.objects.get(code=code)',
    '  File "/usr/local/lib/python3.11/site-packages/django/db/models/manager.py", line 87, in manager_method',
    '    return getattr(self.get_queryset(), name)(*args, **kwargs)',
    'shop.models.Coupon.DoesNotExist: Coupon matching query does not exist.',
    'Time: 0.412 seconds',
  ].join('\n')

  const report = parsePythonTraceback(text)
  assert.equal(report.exception_type, 'DoesNotExist')
  assert.equal(report.exception_module, 'shop.models.Coupon')
  assert.equal(report.exception_message, 'Coupon matching query does not exist.')
  assert.equal(report.elapsed_seconds, 0.412)
  assert.equal(report.deepest_project_frame?.file, '/srv/app/shop/views.py')
  assert.equal(report.coverage.confidence, 1)
  assert.ok(report.warnings.some((warning) => /surrounding log line/.test(warning)))
})

test('a truncated, garbled traceback degrades coverage instead of dropping lines', () => {
  const text = [
    'Traceback (most recent call last):',
    '  File "/srv/app/shop/views.py", line 52',
    '    total = sum(item.price for item in items',
    '            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
    '*** worker 7 restarting after SIGKILL ***',
    'SyntaxError: expected \')\'',
    'please check the deployment logs for the full report',
  ].join('\n')

  const report = parsePythonTraceback(text)
  // The exception line is still read, but the surrounding garbage is not.
  assert.equal(report.exception_type, 'SyntaxError')
  assert.equal(report.blocks.length, 1)
  assert.equal(report.blocks[0]?.syntax?.line_number, 52)
  assert.equal(report.frames.length, 1)
  assert.equal(report.coverage.total_lines, 7)
  assert.equal(report.coverage.parsed_lines, 6)
  assert.equal(report.coverage.unknown_count, 1)
  assert.equal(report.coverage.confidence, 0.857)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [5],
  )
  assert.equal(report.coverage.unknown_lines[0]?.text, '*** worker 7 restarting after SIGKILL ***')
  assert.equal(report.coverage.unknown_truncated, false)
})

test('log framing inside a traceback is never absorbed as a frame source line', () => {
  const text = [
    'Traceback (most recent call last):',
    '  File "/srv/app/shop/helpers.py", line 30, in helper',
    '*** worker 7 restarting after SIGKILL ***',
    '    raise RuntimeError("boom")',
    'RuntimeError: boom',
  ].join('\n')

  const report = parsePythonTraceback(text)
  // Without the adjacency-and-indent rule, the `***` line would be sliced into
  // the frame as its source and the real source line would be the casualty.
  assert.equal(report.frames[0]?.source, null)
  assert.equal(report.exception_type, 'RuntimeError')
  assert.equal(report.exception_message, 'boom')
  assert.equal(report.coverage.total_lines, 5)
  assert.equal(report.coverage.parsed_lines, 3)
  assert.equal(report.coverage.unknown_count, 2)
  assert.equal(report.coverage.confidence, 0.6)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [3, 4],
  )
  assert.equal(report.coverage.unknown_lines[0]?.text, '*** worker 7 restarting after SIGKILL ***')
})

test('prose that is not a report is reported as unrecognized, never absorbed', () => {
  const text = [
    'Traceback (most recent call last):',
    '  File "/srv/app/shop/views.py", line 12, in post',
    '    return self.helper(request)',
    '*** worker 7 restarting after SIGKILL ***',
    'Traceback (most recent call last',
    '  File "/srv/app/shop/helpers.py", line ',
    '    raise ValueError("bad coupon")',
  ].join('\n')

  const report = parsePythonTraceback(text)
  assert.equal(report.exception_type, null)
  assert.equal(report.blocks.length, 1)
  assert.equal(report.blocks[0]?.exception_type, '')
  assert.equal(report.frames.length, 1)
  assert.equal(report.coverage.total_lines, 7)
  assert.equal(report.coverage.parsed_lines, 3)
  assert.equal(report.coverage.unknown_count, 4)
  assert.equal(report.coverage.confidence, 0.429)

  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [4, 5, 6, 7],
  )
  assert.equal(report.coverage.unknown_lines[0]?.text, '*** worker 7 restarting after SIGKILL ***')
  assert.equal(report.coverage.unknown_truncated, false)
  assert.ok(report.warnings.some((warning) => /has no exception line/.test(warning)))
})

test('an empty or non-traceback input yields an honest zero report', () => {
  const report = parsePythonTraceback('')
  assert.equal(report.exception_type, null)
  assert.equal(report.coverage.total_lines, 0)
  assert.equal(report.coverage.parsed_lines, 0)
  assert.equal(report.coverage.confidence, 1)
  assert.ok(report.warnings.some((warning) => /Traceback/.test(warning)))

  const prose = parsePythonTraceback('the deploy failed\nplease check the logs\n')
  assert.equal(prose.exception_type, null)
  assert.equal(prose.coverage.unknown_count, 2)
  assert.equal(prose.coverage.confidence, 0)
})

/** Summarize a report the way a bug tracker would, proving the interface is usable. */
function summarize(report: TracebackReport): string {
  return `${report.exception_type ?? 'unknown'} at ${report.deepest_project_frame?.file ?? 'n/a'}:${report.deepest_project_frame?.line ?? 0}`
}

test('the parsed report is directly usable as a diagnosis', () => {
  const report = parsePythonTraceback(DJANGO_TRACEBACK)
  assert.equal(summarize(report), 'OperationalError at /srv/app/shop/migrations/0002_order_total.py:17')
})

test('classifyOrigin only claims what a path proves', () => {
  assert.equal(classifyOrigin('/srv/app/shop/views.py'), 'project')
  assert.equal(classifyOrigin('/usr/local/lib/python3.11/site-packages/django/db/models/query.py'), 'installed')
  assert.equal(classifyOrigin('/usr/lib/python3/dist-packages/celery/app/base.py'), 'installed')
  assert.equal(classifyOrigin('/usr/local/lib/python3.11/json/decoder.py'), 'stdlib')
  assert.equal(classifyOrigin('<string>'), 'unknown')
  assert.equal(classifyOrigin('views.py'), 'unknown')
})

