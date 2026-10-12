/**
 * pytest parser tests, using a verbatim `pytest -ra -q --durations=3` transcript
 * and deliberately damaged variants.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePytestSummary } from '../src/core/pytest.ts'

/** Verbatim `pytest -ra -q --durations=3` output for a small Django suite. */
const PYTEST_RA = [
  '........................F...........E                                    [ 92%]', // 1
  '=========== slowest 3 durations ===========', // 2
  '0.83s call     tests/test_orders.py::test_checkout_flow', // 3
  '0.41s call     tests/test_orders.py::test_cancel_order', // 4
  '0.12s setup    tests/test_orders.py::test_apply_coupon', // 5
  '', // 6
  '================================ FAILURES =================================', // 7
  '_____________________ test_apply_coupon ______________________', // 8
  '', // 9
  'client = <django.test.client.Client object at 0x7f9c1d2e3a90>', // 10
  '', // 11
  '    def test_apply_coupon(client):', // 12
  '        order = Order.objects.create(total=Decimal("120.00"))', // 13
  '        response = client.post("/checkout/apply/", {"code": "SAVE20"})', // 14
  '>       assert response.json()["discount"] == "24.00"', // 15
  'E       KeyError: \'discount\'', // 16
  '', // 17
  'tests/test_orders.py:58: KeyError', // 18
  '=========== short test summary info ===========', // 19
  'FAILED tests/test_orders.py::test_apply_coupon - KeyError: \'discount\'', // 20
  'ERROR tests/test_orders.py::test_cancel_order - django.db.utils.OperationalError: no such table: shop_order', // 21
  '1 failed, 1 error, 36 passed, 2 warnings in 21.44s', // 22
].join('\n')

test('pytest_summary reads the status line, short summary and assertion excerpt', () => {
  const report = parsePytestSummary(PYTEST_RA)
  assert.deepEqual(report.counts, {
    passed: 36,
    failed: 1,
    errors: 1,
    skipped: 0,
    xfailed: 0,
    xpassed: 0,
    warnings: 2,
    deselected: 0,
  })
  assert.equal(report.duration_seconds, 21.44)
  assert.equal(report.status_line, '1 failed, 1 error, 36 passed, 2 warnings in 21.44s')
  assert.equal(report.status_line_number, 22)
  assert.equal(report.total, 38)

  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0]?.test_id, 'test_apply_coupon')
  assert.equal(report.failures[0]?.kind, 'FAILED')
  assert.equal(report.failures[0]?.header_line, 8)
  assert.equal(report.failures[0]?.file, 'tests/test_orders.py')
  assert.equal(report.failures[0]?.line, 58)
  assert.deepEqual(report.failures[0]?.excerpt, ["KeyError: 'discount'"])
  assert.equal(report.failures[0]?.excerpt_truncated, false)

  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0]?.test_id, 'tests/test_orders.py::test_cancel_order')
  assert.equal(report.errors[0]?.kind, 'ERROR')
  assert.equal(report.errors[0]?.file, 'tests/test_orders.py')
  assert.deepEqual(report.errors[0]?.excerpt, [])

  assert.deepEqual(report.short_summary, [
    { status: 'failed', test_id: 'tests/test_orders.py::test_apply_coupon', detail: "KeyError: 'discount'" },
    {
      status: 'error',
      test_id: 'tests/test_orders.py::test_cancel_order',
      detail: 'django.db.utils.OperationalError: no such table: shop_order',
    },
  ])

  assert.deepEqual(report.durations.map((entry) => `${entry.seconds}${entry.phase}`), ['0.83call', '0.41call', '0.12setup'])
  assert.equal(report.durations[0]?.test_id, 'tests/test_orders.py::test_checkout_flow')
  assert.equal(report.coverage.confidence, 1)
  assert.equal(report.coverage.parser_version, 'pytest-1')
  assert.deepEqual(report.warnings, [])
})

test('pytest_summary reports absent sections instead of guessing at them', () => {
  const quiet = parsePytestSummary('........................\n24 passed in 3.10s\n')
  assert.equal(quiet.counts.passed, 24)
  assert.equal(quiet.counts.failed, 0)
  assert.equal(quiet.duration_seconds, 3.1)
  assert.equal(quiet.short_summary.length, 0)
  assert.equal(quiet.failures.length, 0)
  assert.ok(quiet.warnings.some((warning) => /short test summary info/.test(warning)))
  assert.equal(quiet.coverage.confidence, 1)
})

test('pytest_summary normalizes every counter and the deselected count', () => {
  const text = [
    '====== short test summary info ======',
    'XFAIL tests/test_billing.py::test_refund_partial',
    'XPASS tests/test_billing.py::test_refund_full',
    'SKIPPED [2] tests/test_billing.py:12: need Redis',
    '5 failed, 2 passed, 3 skipped, 1 xfailed, 1 xpassed, 2 warnings, 4 deselected in 9.51s',
  ].join('\n')

  const report = parsePytestSummary(text)
  assert.deepEqual(report.counts, {
    passed: 2,
    failed: 5,
    errors: 0,
    skipped: 3,
    xfailed: 1,
    xpassed: 1,
    warnings: 2,
    deselected: 4,
  })
  assert.equal(report.duration_seconds, 9.51)
  assert.equal(report.short_summary[0]?.status, 'xfail')
  assert.equal(report.short_summary[1]?.status, 'xpass')
  assert.equal(report.short_summary[2]?.status, 'skipped')
  assert.equal(report.short_summary[2]?.test_id, '[2] tests/test_billing.py:12: need Redis')
  // Five failures are counted but no FAILURES section was printed, so the two
  // `-ra` entries are the only identity evidence available.
  assert.equal(report.failures.length, 0)
})

test('pytest_summary detects a collection error and an interrupted session', () => {
  const text = [
    'ERROR tests/test_billing.py',
    '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
    '1 error in 1.02s',
  ].join('\n')

  const report = parsePytestSummary(text)
  assert.equal(report.counts.errors, 1)
  assert.equal(report.exit_status, 'ERROR tests/test_billing.py')
  assert.equal(report.status_line, '1 error in 1.02s')
  assert.equal(report.coverage.confidence, 1)

  const banner = parsePytestSummary('no tests ran in 0.01s\n')
  assert.equal(banner.exit_status, 'no tests ran in 0.01s')
  assert.ok(banner.warnings.some((warning) => /status line/.test(warning)))
})

test('a garbled pytest excerpt keeps what it can and admits what it could not read', () => {
  const text = [
    '===== FAILURES =====',
    '____ test_total ____',
    'E   assert 3 == 4',
    '9 passed, 1 warning in 1.00s',
    '<<< log rotated, remainder lost >>>',
  ].join('\n')

  const report = parsePytestSummary(text)
  // The `FAILURES` header is intact, so the assertion and status lines are still
  // read; the pseudo-header is too short to be a real pytest header and the log
  // notice belongs to no grammar, so both are reported as unrecognized.
  assert.equal(report.status_line, '9 passed, 1 warning in 1.00s')
  assert.equal(report.counts.passed, 9)
  assert.equal(report.failures.length, 0)
  assert.ok(report.warnings.some((warning) => /short test summary info/.test(warning)))
  assert.equal(report.coverage.total_lines, 5)
  assert.equal(report.coverage.parsed_lines, 3)
  assert.equal(report.coverage.unknown_count, 2)
  assert.equal(report.coverage.confidence, 0.6)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [2, 5],
  )
  assert.equal(report.coverage.unknown_lines[0]?.text, '____ test_total ____')
  assert.equal(report.coverage.unknown_lines[1]?.text, '<<< log rotated, remainder lost >>>')
})

test('pytest_summary bounds an excerpt at twelve lines', () => {
  const body = Array.from({ length: 20 }, (_unused, index) => `E   line ${index + 1} of the failure`).join('\n')
  const text = `===== FAILURES =====\n________________________ test_deep ________________________\n${body}\n0 passed, 1 failed in 0.10s\n`
  const report = parsePytestSummary(text)
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0]?.test_id, 'test_deep')
  assert.equal(report.failures[0]?.excerpt.length, 12)
  assert.equal(report.failures[0]?.excerpt_truncated, true)
  assert.equal(report.failures[0]?.excerpt[11], 'line 12 of the failure')
})
