/**
 * SQL log tests, using verbatim Django `connection.queries`/`DEBUG` log lines.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSqlLog, normalizeSql, tablesOf, verbOf } from '../src/core/sql.ts'

/** Verbatim Django `django.db.backends` DEBUG lines from one request. */
const SQL_LOG = [
  '(0.002) SELECT "shop_order"."id", "shop_order"."total" FROM "shop_order" WHERE "shop_order"."user_id" = 7 LIMIT 21; args=(7,)', // 1
  '(0.004) SELECT "shop_product"."id", "shop_product"."title" FROM "shop_product" WHERE "shop_product"."order_id" = 11 LIMIT 21; args=(11,)', // 2
  '(0.001) SELECT "shop_product"."id", "shop_product"."title" FROM "shop_product" WHERE "shop_product"."order_id" = 12 LIMIT 21; args=(12,)', // 3
  '(0.001) SELECT "shop_product"."id", "shop_product"."title" FROM "shop_product" WHERE "shop_product"."order_id" = 13 LIMIT 21; args=(13,)', // 4
  '(0.001) SELECT "shop_product"."id", "shop_product"."title" FROM "shop_product" WHERE "shop_product"."order_id" = 14 LIMIT 21; args=(14,)', // 5
  '(0.003) UPDATE "shop_order" SET "total" = 120.00 WHERE "shop_order"."id" = 11', // 6
  '(0.001) SELECT COUNT(*) AS "__count" FROM "shop_coupon" WHERE "shop_coupon"."active"', // 7
].join('\n')

test('django_sql_n_plus_one groups repeated statements and names the N+1', () => {
  const report = analyzeSqlLog(SQL_LOG)
  assert.equal(report.total_queries, 7)
  assert.equal(report.distinct_queries, 4)
  assert.equal(report.min_repeats, 3)
  assert.equal(report.groups_truncated, false)
  assert.deepEqual(report.candidates.map((group) => group.count), [4])

  const hot = report.candidates[0]
  assert.equal(hot?.verb, 'SELECT')
  assert.equal(hot?.n_plus_one, true)
  assert.deepEqual(hot?.tables, ['shop_product'])
  assert.equal(hot?.first_line, 2)
  assert.deepEqual(hot?.lines, [2, 3, 4, 5])
  assert.equal(
    hot?.normalized,
    'SELECT "shop_product"."id", "shop_product"."title" FROM "shop_product" WHERE "shop_product"."order_id" = ? LIMIT ?',
  )
  assert.equal(
    hot?.example,
    // The duration prefix is stripped; the driver's `args=` suffix is kept in the
    // example because it shows the values that were bound.
    'SELECT "shop_product"."id", "shop_product"."title" FROM "shop_product" WHERE "shop_product"."order_id" = 11 LIMIT 21; args=(11,)',
  )

  // The two singletons are reported as groups too, just not as candidates.
  assert.deepEqual(
    report.groups.map((group) => group.count),
    [4, 1, 1, 1],
  )
  const update = report.groups.find((group) => group.verb === 'UPDATE')
  assert.deepEqual(update?.tables, ['shop_order'])
  assert.equal(update?.first_line, 6)
  assert.equal(report.coverage.confidence, 1)
  assert.deepEqual(report.warnings, [])
})

test('django_sql_n_plus_one honors a custom repetition threshold', () => {
  const report = analyzeSqlLog(SQL_LOG, 2)
  assert.equal(report.min_repeats, 2)
  assert.deepEqual(report.candidates.map((group) => group.count), [4])
  assert.equal(report.candidates[0]?.n_plus_one, true)

  const strict = analyzeSqlLog(SQL_LOG, 5)
  assert.deepEqual(strict.candidates, [])
  assert.equal(strict.groups[0]?.n_plus_one, false)
})

test('django_sql_n_plus_one reads values that differ only by literals as one group', () => {
  const text = [
    'SELECT "shop_order"."id" FROM "shop_order" WHERE "shop_order"."user_id" = 1',
    "SELECT \"shop_order\".\"id\" FROM \"shop_order\" WHERE \"shop_order\".\"user_id\" = 2",
    'SELECT "shop_order"."id" FROM "shop_order" WHERE "shop_order"."user_id" = 3',
  ].join('\n')

  const report = analyzeSqlLog(text)
  assert.equal(report.total_queries, 3)
  assert.equal(report.distinct_queries, 1)
  assert.equal(report.candidates.length, 1)
  assert.equal(report.candidates[0]?.count, 3)
  assert.deepEqual(report.candidates[0]?.lines, [1, 2, 3])
  // Every line after the first still counts as read even though it collapses into
  // the same group.
  assert.equal(report.coverage.parsed_lines, 3)
  assert.equal(report.coverage.unknown_count, 0)
})

test('django_sql_n_plus_one reads JSON-lines query logs', () => {
  const text = [
    '{"time": "2026-01-08T11:02:03.114", "sql": "SELECT \\"shop_order\\".\\"id\\" FROM \\"shop_order\\" WHERE \\"shop_order\\".\\"id\\" = 1", "duration_ms": 2.1}',
    '{"time": "2026-01-08T11:02:03.220", "sql": "SELECT \\"shop_order\\".\\"id\\" FROM \\"shop_order\\" WHERE \\"shop_order\\".\\"id\\" = 2", "duration_ms": 1.7}',
    '{"time": "2026-01-08T11:02:03.331", "sql": "SELECT \\"shop_order\\".\\"id\\" FROM \\"shop_order\\" WHERE \\"shop_order\\".\\"id\\" = 3", "duration_ms": 1.9}',
  ].join('\n')

  const report = analyzeSqlLog(text)
  assert.equal(report.total_queries, 3)
  assert.equal(report.distinct_queries, 1)
  assert.equal(report.candidates[0]?.count, 3)
  assert.equal(report.candidates[0]?.first_line, 1)
})

test('django_sql_n_plus_one refuses to guess at a truncated log', () => {
  const text = [
    'SELECT "shop_product"."id" FROM "shop_product" WHERE "shop_product"."order_id" = 11',
    'SELECT "shop_product"."id" FROM "shop_product" WHERE "shop_product"."order_id" = 12',
    'SELECT "shop_product"."id" FROM "shop_product" WHERE "shop_product"."order_id" = 13',
    'Traceback (most recent call last):',
    '  File "/srv/app/shop/views.py", line 42, in list_orders',
    '    for product in order.products.all():',
  ].join('\n')

  const report = analyzeSqlLog(text)
  assert.equal(report.total_queries, 3)
  assert.equal(report.candidates[0]?.count, 3)
  assert.equal(report.coverage.total_lines, 6)
  // The traceback lines are reported as unread rather than mistaken for SQL.
  assert.equal(report.coverage.parsed_lines, 3)
  assert.equal(report.coverage.unknown_count, 3)
  assert.equal(report.coverage.confidence, 0.5)
  assert.deepEqual(
    report.coverage.unknown_lines.map((sample) => sample.line),
    [4, 5, 6],
  )
})

test('an empty SQL log yields an honest zero report', () => {
  const report = analyzeSqlLog('')
  assert.equal(report.total_queries, 0)
  assert.equal(report.distinct_queries, 0)
  assert.deepEqual(report.groups, [])
  assert.deepEqual(report.candidates, [])
  assert.equal(report.coverage.total_lines, 0)
  assert.equal(report.coverage.confidence, 1)
  assert.ok(report.warnings.some((warning) => /no SQL statement/.test(warning)))
})

test('django_sql_n_plus_one joins a statement printed across several lines', () => {
  const text = [
    '(0.006) SELECT "shop_order"."id",',
    '               "shop_order"."total"',
    '        FROM "shop_order"',
    '        WHERE "shop_order"."user_id" = 7',
    '        ORDER BY "shop_order"."id" DESC',
  ].join('\n')

  const report = analyzeSqlLog(text)
  assert.equal(report.total_queries, 1)
  assert.equal(report.distinct_queries, 1)
  assert.deepEqual(report.groups[0]?.tables, ['shop_order'])
  assert.equal(
    report.groups[0]?.normalized,
    'SELECT "shop_order"."id", "shop_order"."total" FROM "shop_order" WHERE "shop_order"."user_id" = ? ORDER BY "shop_order"."id" DESC',
  )
  assert.equal(report.coverage.parsed_lines, 5)
  assert.equal(report.coverage.unknown_count, 0)
})

test('normalizeSql, verbOf and tablesOf are pure and infallible', () => {
  assert.equal(normalizeSql('SELECT  *\n  FROM "shop_order"'), 'SELECT * FROM "shop_order"')
  assert.equal(normalizeSql("SELECT * FROM t WHERE name = 'Ann' AND id = 4"), 'SELECT * FROM t WHERE name = ? AND id = ?')
  assert.equal(verbOf('WITH recent AS (SELECT 1) SELECT * FROM recent'), 'WITH')
  assert.equal(verbOf('EXPLAIN SELECT 1'), 'EXPLAIN')
  assert.equal(verbOf(''), 'UNKNOWN')
  assert.deepEqual(tablesOf('SELECT * FROM "shop_order" JOIN shop_product ON true'), ['shop_order', 'shop_product'])
  assert.deepEqual(tablesOf(''), [])
})
