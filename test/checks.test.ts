/**
 * `manage.py check` / `manage.py check --deploy` report tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDjangoChecks } from '../src/core/checks.ts'

/** Verbatim `python manage.py check` output for a project with three issues. */
const CHECK = [
  'System check identified some issues:', // 1
  '', // 2
  'WARNINGS:', // 3
  'shop.Order.total: (fields.W161) Fixed default value provided.', // 4
  '\tHINT: It seems you set a fixed date / time / datetime value as default for this field.', // 5
  'shop.Order.discount: (fields.E130) DecimalFields must define a decimal_places attribute.', // 6
  '', // 7
  'ERRORS:', // 8
  'shop.Coupon.code: (fields.E120) CharFields must define a max_length attribute.', // 9
  '', // 10
  'System check identified 3 issues (0 silenced).', // 11
].join('\n')

test('django_checks splits findings by level with ids, objects and hints', () => {
  const report = parseDjangoChecks(CHECK)
  assert.equal(report.findings.length, 3)
  assert.deepEqual(report.counts, { ERROR: 1, WARNING: 2, INFO: 0, DEBUG: 0 })
  assert.equal(report.summary_line, 'System check identified 3 issues (0 silenced).')
  assert.equal(report.issue_count, 3)
  assert.equal(report.clean, false)
  assert.equal(report.deploy_section_present, false)
  assert.deepEqual(report.deploy_findings, [])

  assert.deepEqual(report.findings[0], {
    level: 'WARNING',
    message: 'Fixed default value provided.',
    id: 'fields.W161',
    deploy: false,
    object: 'shop.Order.total',
    hint: 'It seems you set a fixed date / time / datetime value as default for this field.',
    line: 4,
  })
  assert.equal(report.findings[1]?.level, 'WARNING')
  assert.equal(report.findings[1]?.id, 'fields.E130')
  assert.equal(report.findings[1]?.hint, null)
  assert.equal(report.findings[2]?.level, 'ERROR')
  assert.equal(report.findings[2]?.id, 'fields.E120')
  assert.equal(report.findings[2]?.object, 'shop.Coupon.code')
  assert.equal(report.findings[2]?.line, 9)

  assert.equal(report.coverage.confidence, 1)
  assert.equal(report.coverage.parser_version, 'checks-1')
  assert.deepEqual(report.warnings, [])
})

test('django_checks reads a clean run as clean', () => {
  const report = parseDjangoChecks('System check identified no issues (0 silenced).\n')
  assert.equal(report.clean, true)
  assert.equal(report.issue_count, 0)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.counts, { ERROR: 0, WARNING: 0, INFO: 0, DEBUG: 0 })
  assert.deepEqual(report.warnings, [])
})

test('django_checks reads a `check --deploy` item block', () => {
  const deploy = [
    'System check identified some issues:', // 1
    '', // 2
    'WARNINGS:', // 3
    '?: (security.W004) You have not set a value for the SECURE_HSTS_SECONDS setting.', // 4
    '\tHINT: Set SECURE_HSTS_SECONDS to a positive integer.', // 5
    '?: (security.W008) Your SECURE_SSL_REDIRECT setting is not set to True.', // 6
    '?: (security.W018) You should not have DEBUG set to True in deployment.', // 7
    '', // 8
    'System check identified 3 issues (0 silenced).', // 9
  ].join('\n')

  const report = parseDjangoChecks(deploy)
  assert.equal(report.deploy_section_present, true)
  assert.equal(report.deploy_findings.length, 3)
  assert.deepEqual(
    report.deploy_findings.map((finding) => finding.id),
    ['security.W004', 'security.W008', 'security.W018'],
  )
  assert.equal(report.findings[0]?.deploy, true)
  assert.equal(report.findings[0]?.object, null)
  assert.equal(report.findings[0]?.hint, 'Set SECURE_HSTS_SECONDS to a positive integer.')
  assert.equal(report.findings[0]?.message, 'You have not set a value for the SECURE_HSTS_SECONDS setting.')
  assert.equal(report.counts.WARNING, 3)
})

test('django_checks reads ERRORS/WARNINGS section headers and INFO findings', () => {
  const report = parseDjangoChecks([
    'ERRORS:',
    'shop.Coupon.code: (fields.E120) CharFields must define a max_length attribute.',
    'WARNINGS:',
    'shop.Order.total: (fields.W161) Fixed default value provided.',
    'INFO:',
    'shop.Coupon: (models.I001) Something informational.',
  ].join('\n'))

  assert.equal(report.counts.ERROR, 1)
  assert.equal(report.counts.WARNING, 1)
  assert.equal(report.counts.INFO, 1)
  assert.equal(report.summary_line, null)
  assert.equal(report.issue_count, null)
  assert.equal(report.clean, false)
  assert.ok(report.warnings.some((warning) => /no `System check identified/.test(warning)))
})
test('a garbled check report admits the lines it could not read', () => {
  const garbled = [
    'System check identified some issues:',
    'WARNINGS:',
    'shop.Order.total: (fields.W161) Fixed default value provided.',
    '<<< 12 more lines were dropped when the terminal scrolled >>>',
    'System check identified 3 issues (0 silenced).',
  ].join('\n')

  const report = parseDjangoChecks(garbled)
  assert.equal(report.issue_count, 3)
  assert.equal(report.findings.length, 1)
  assert.ok(report.warnings.some((warning) => /1 finding block\(s\) were recognized/.test(warning)))
  assert.equal(report.coverage.total_lines, 5)
  assert.equal(report.coverage.parsed_lines, 4)
  assert.equal(report.coverage.unknown_count, 1)
  assert.equal(report.coverage.confidence, 0.8)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [4],
  )
})

test('an empty or unrelated paste yields an honest empty report', () => {
  const report = parseDjangoChecks('')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary_line, null)
  assert.equal(report.issue_count, null)
  assert.equal(report.clean, false)
  assert.equal(report.coverage.total_lines, 0)
  assert.equal(report.coverage.confidence, 1)
  assert.ok(report.warnings.some((warning) => /does not look like/.test(warning)))
})
