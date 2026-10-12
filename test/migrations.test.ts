/**
 * Django migration report tests, using verbatim `showmigrations` transcripts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDjangoMigrations } from '../src/core/migrations.ts'

/** Verbatim `python manage.py showmigrations` output for a Django project. */
const SHOWMIGRATIONS = [
  'admin', // 1
  ' [X] 0001_initial', // 2
  ' [X] 0002_logentry_remove_auto_add', // 3
  ' [X] 0003_logentry_add_action_flag_choices', // 4
  'auth', // 5
  ' [X] 0001_initial', // 6
  ' [X] 0002_alter_permission_name_max_length', // 7
  'contenttypes', // 8
  ' [X] 0001_initial', // 9
  ' [X] 0002_remove_content_type_name', // 10
  'sessions', // 11
  ' [X] 0001_initial', // 12
  'shop', // 13
  ' [X] 0001_initial', // 14
  ' [X] 0002_order_discount', // 15
  ' [ ] 0003_alter_order_total', // 16
  ' [ ] 0004_coupon_index', // 17
  'django_celery_results', // 18
  ' (no migrations)', // 19
].join('\n')

test('django_migrations splits the report per app and flags what is unapplied', () => {
  const report = parseDjangoMigrations(SHOWMIGRATIONS)
  assert.deepEqual(
    report.apps.map((app) => app.app),
    ['admin', 'auth', 'contenttypes', 'sessions', 'shop', 'django_celery_results'],
  )
  assert.equal(report.total_apps, 6)
  assert.equal(report.applied_total, 10)
  assert.equal(report.unapplied_total, 2)
  assert.deepEqual(report.apps_with_unapplied, ['shop'])
  assert.deepEqual(report.apps_with_no_migrations, ['django_celery_results'])
  assert.equal(report.plan_needed, true)
  assert.deepEqual(report.databases, [])

  const shop = report.apps[4]
  assert.deepEqual(shop?.applied, ['0001_initial', '0002_order_discount'])
  assert.deepEqual(shop?.unapplied, ['0003_alter_order_total', '0004_coupon_index'])
  assert.equal(shop?.applied_count, 2)
  assert.equal(shop?.unapplied_count, 2)
  assert.equal(shop?.no_migrations, false)
  assert.deepEqual(shop?.migrations, [
    { name: '0001_initial', applied: true, line: 14 },
    { name: '0002_order_discount', applied: true, line: 15 },
    { name: '0003_alter_order_total', applied: false, line: 16 },
    { name: '0004_coupon_index', applied: false, line: 17 },
  ])
  assert.equal(shop?.database, null)

  assert.equal(report.apps[5]?.no_migrations, true)
  assert.deepEqual(report.apps[5]?.migrations, [])
  assert.equal(report.coverage.confidence, 1)
  assert.equal(report.coverage.parser_version, 'migrations-1')
  assert.deepEqual(report.warnings, [])
})

test('django_migrations reads a fully applied database as no plan needed', () => {
  const applied = [
    'admin',
    ' [X] 0001_initial',
    'auth',
    ' [X] 0001_initial',
    'contenttypes',
    ' [X] 0001_initial',
    'sessions',
    ' [X] 0001_initial',
  ].join('\n')

  const report = parseDjangoMigrations(applied)
  assert.equal(report.plan_needed, false)
  assert.equal(report.unapplied_total, 0)
  assert.deepEqual(report.apps_with_unapplied, [])
  assert.equal(report.applied_total, 4)
  assert.deepEqual(report.warnings, [])
})

test('django_migrations reads the flat `migrate --plan` layout', () => {
  const plan = [
    'Planned operations:',
    'shop.0003_alter_order_total',
    '    Alter field total on order',
    'shop.0004_coupon_index',
    '    Create index on coupon',
    'admin.0002_logentry_remove_auto_add',
    '    Alter field action_flag on logentry',
  ].join('\n')

  const report = parseDjangoMigrations(plan)
  // `--plan` prints no checkboxes, so nothing can be claimed as applied and the
  // tool reports the app blocks it could not see rather than inventing entries.
  assert.equal(report.applied_total, 0)
  assert.equal(report.unapplied_total, 0)
  assert.equal(report.plan_needed, false)
  assert.ok(report.coverage.unknown_count > 0)
})

test('django_migrations attributes multi-database blocks and warns about them', () => {
  const multi = [
    'default',
    'admin',
    ' [X] 0001_initial',
    'shop',
    ' [X] 0001_initial',
    ' [ ] 0002_order_discount',
    'analytics (analytics_db)',
    ' [X] 0001_initial',
    ' [ ] 0002_add_fact_table',
  ].join('\n')

  const report = parseDjangoMigrations(multi)
  assert.equal(report.applied_total, 3)
  assert.equal(report.unapplied_total, 2)
  assert.equal(report.plan_needed, true)
  const analytics = report.apps.find((app) => app.app === 'analytics')
  assert.equal(analytics?.database, 'analytics_db')
  assert.deepEqual(analytics?.unapplied, ['0002_add_fact_table'])
  assert.deepEqual(report.databases, ['analytics_db'])
})

test('a truncated migration report keeps its counts honest', () => {
  const truncated = [
    'shop',
    ' [X] 0001_initial',
    ' [ ] 0002_order_discount',
    ' [ ] 0003_alter_order_total',
    '<<< output truncated by the terminal buffer >>>',
  ].join('\n')

  const report = parseDjangoMigrations(truncated)
  assert.equal(report.applied_total, 1)
  assert.equal(report.unapplied_total, 2)
  assert.deepEqual(report.apps_with_unapplied, ['shop'])
  assert.equal(report.coverage.total_lines, 5)
  assert.equal(report.coverage.parsed_lines, 4)
  assert.equal(report.coverage.unknown_count, 1)
  assert.equal(report.coverage.confidence, 0.8)
  assert.equal(report.coverage.unknown_lines[0]?.line, 5)
  assert.equal(report.coverage.unknown_lines[0]?.text, '<<< output truncated by the terminal buffer >>>')
})

test('an empty or unrelated paste yields an honest empty report', () => {
  const report = parseDjangoMigrations('')
  assert.deepEqual(report.apps, [])
  assert.equal(report.total_apps, 0)
  assert.equal(report.plan_needed, false)
  assert.equal(report.coverage.total_lines, 0)
  assert.equal(report.coverage.parsed_lines, 0)
  assert.equal(report.coverage.confidence, 1)
  assert.ok(report.warnings.some((warning) => /no app blocks/.test(warning)))
})
