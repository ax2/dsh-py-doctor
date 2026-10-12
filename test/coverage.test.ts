/**
 * Coverage ledger and receipt-envelope tests: the two mechanisms that make every
 * other result trustworthy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoverageLedger, MAX_UNKNOWN_SAMPLES, MAX_UNKNOWN_SAMPLE_CHARS, coverageNote } from '../src/core/coverage.ts'
import { envelope, metaOf, renderEnvelope } from '../src/core/receipt.ts'
import { BoundedInputError, UnsupportedOptionError, assertWithinInput, clipItems, clipToBytes, jsonBytes, numberedLines, utf8Bytes } from '../src/core/bytes.ts'

test('the ledger counts recognized, consumed and rejected lines separately', () => {
  const ledger = new CoverageLedger()
  ledger.see(1, 'Traceback (most recent call last):')
  ledger.see(2, '  File "x.py", line 1, in f')
  ledger.see(3, '    boom()')
  ledger.see(4, 'garbage here')
  ledger.recognize(1)
  ledger.recognize(2)
  ledger.consume(3)
  ledger.reject(4)
  const coverage = ledger.coverage('test-1')
  assert.equal(coverage.total_lines, 4)
  assert.equal(coverage.parsed_lines, 3)
  assert.equal(coverage.unknown_count, 1)
  assert.equal(coverage.confidence, 0.75)
  assert.equal(coverage.parser_version, 'test-1')
  assert.deepEqual(coverage.unknown_lines, [{ line: 4, text: 'garbage here' }])
  assert.equal(coverage.unknown_truncated, false)
})

test('blank lines are counted physically but excluded from the denominator', () => {
  const ledger = new CoverageLedger()
  ledger.see(1, 'only line')
  ledger.see(2, '')
  ledger.see(3, '   ')
  ledger.recognize(1)
  ledger.reject(2)
  ledger.reject(3)
  const coverage = ledger.coverage('test-1')
  assert.equal(coverage.total_lines, 3)
  assert.equal(coverage.parsed_lines, 1)
  assert.equal(coverage.unknown_count, 0)
  assert.equal(coverage.confidence, 1)
  assert.deepEqual(coverage.unknown_lines, [])
})

test('an empty report has full confidence because nothing was skipped', () => {
  const coverage = new CoverageLedger().coverage('test-1')
  assert.equal(coverage.total_lines, 0)
  assert.equal(coverage.confidence, 1)
  assert.equal(coverageNote(coverage), 'parse coverage 100.0% (0/0 recognized lines, 0 unknown, parser test-1)')
})

test('a line can only be claimed once, and consume beats reject', () => {
  const ledger = new CoverageLedger()
  ledger.see(1, 'a')
  ledger.see(2, 'b')
  ledger.reject(1)
  ledger.recognize(1)
  ledger.consume(1)
  ledger.consume(2)
  ledger.reject(2)
  const coverage = ledger.coverage('test-1')
  assert.equal(coverage.unknown_count, 0)
  assert.equal(coverage.parsed_lines, 2)
  assert.equal(coverage.confidence, 1)
})

test('the ledger samples unknown lines up to a fixed budget', () => {
  const ledger = new CoverageLedger()
  for (let number = 1; number <= 12; number += 1) {
    ledger.see(number, `unknown ${'x'.repeat(300)}`)
    ledger.reject(number)
  }
  const coverage = ledger.coverage('test-1')
  assert.equal(coverage.unknown_count, 12)
  assert.equal(coverage.unknown_lines.length, MAX_UNKNOWN_SAMPLES)
  assert.equal(coverage.unknown_truncated, true)
  assert.equal(coverage.unknown_lines[0]?.line, 1)
  // 200 characters kept, plus the ellipsis that marks the cut.
  assert.equal(coverage.unknown_lines[0]?.text.length, MAX_UNKNOWN_SAMPLE_CHARS + 1)
  assert.ok(coverage.unknown_lines[0]?.text.endsWith('…'))
  assert.ok(coverageNote(coverage).includes('12 unknown'))
})

test('confidence is rounded to three decimals', () => {
  const ledger = new CoverageLedger()
  for (let number = 1; number <= 7; number += 1) {
    ledger.see(number, `line ${number}`)
    if (number <= 3) ledger.recognize(number)
    else ledger.reject(number)
  }
  assert.equal(ledger.coverage('test-1').confidence, 0.429)
})

test('clipToBytes cuts on a code point boundary and never splits a surrogate', () => {
  const text = '日本語のログ'.repeat(4)
  const clipped = clipToBytes(text, 10)
  assert.ok(clipped.bytes <= 10)
  assert.equal(clipped.truncated, true)
  assert.equal(clipped.text, '日本語')
  // A long ASCII run is cut to the byte budget exactly.
  const ascii = clipToBytes('abcdefghij', 4)
  assert.equal(ascii.text, 'abcd')
  assert.equal(ascii.truncated, true)
  const fits = clipToBytes('abc', 16)
  assert.equal(fits.text, 'abc')
  assert.equal(fits.bytes, 3)
  assert.equal(fits.truncated, false)
})

test('assertWithinInput refuses an over-budget input instead of clipping it', () => {
  const text = 'x'.repeat(100)
  assert.equal(assertWithinInput(text, 100, 'report'), 100)
  assert.throws(() => assertWithinInput(text, 99, 'report'), (error: unknown) => {
    assert.ok(error instanceof BoundedInputError)
    assert.equal(error.code, 'INPUT_TOO_LARGE')
    assert.equal(error.actualBytes, 100)
    assert.equal(error.limitBytes, 99)
    assert.ok(error.message.startsWith('report is 100 UTF-8 bytes'))
    assert.ok(error.message.includes('nothing was truncated or partially processed'))
    return true
  })
})

test('clipItems caps a list without mutating it', () => {
  const items = [1, 2, 3, 4, 5]
  const clipped = clipItems(items, 2)
  assert.deepEqual(clipped.items, [1, 2])
  assert.equal(clipped.truncated, true)
  assert.deepEqual(items, [1, 2, 3, 4, 5])
  assert.equal(clipItems(items, 9).truncated, false)
})

test('numberedLines strips CR, drops the trailing newline and never renumbers', () => {
  assert.deepEqual(numberedLines('a\r\nb\r\n'), [
    { number: 1, text: 'a' },
    { number: 2, text: 'b' },
  ])
  assert.deepEqual(numberedLines('a\n\nb'), [
    { number: 1, text: 'a' },
    { number: 2, text: '' },
    { number: 3, text: 'b' },
  ])
  assert.deepEqual(numberedLines(''), [])
})

test('the receipt envelope reports both sides of the exchange', () => {
  const payload = { ok: true }
  const built = envelope(payload, 12, ['note one'])
  assert.deepEqual(built.meta, { bytesIn: 12, bytesOut: utf8Bytes(JSON.stringify(payload)), truncated: false, notes: ['note one'] })
  assert.deepEqual(built.result, payload)
  assert.deepEqual(metaOf(12, payload, ['why']), {
    bytesIn: 12,
    bytesOut: utf8Bytes(JSON.stringify(payload)),
    truncated: false,
    notes: ['why'],
  })
  assert.equal(metaOf(12, 'text').bytesOut, 4)
  assert.equal(envelope(payload, 12, [], true).meta.truncated, true)
})

test('renderEnvelope appends footers only when there is something to say', () => {
  const quiet = envelope({ ok: true }, 4, [])
  assert.deepEqual(renderEnvelope(quiet), [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }])

  const bounded = envelope({ ok: false }, 40, ['maxFrames reached'], true)
  const rendered = renderEnvelope(bounded)
  assert.equal(rendered.length, 1)
  assert.equal(
    rendered[0]?.text,
    `${JSON.stringify({ ok: false }, null, 2)}\n\n[bounded] input=40B output=12B\n[note] maxFrames reached`,
  )
  // A string payload is rendered verbatim rather than re-encoded.
  assert.equal(renderEnvelope(envelope('plain', 5, []))[0]?.text, 'plain')
})

test('jsonBytes measures the encoded payload, not the object', () => {
  assert.equal(jsonBytes({ a: 1 }), utf8Bytes('{"a":1}'))
})

test('UnsupportedOptionError names the option, the value and the allowed set', () => {
  const error = new UnsupportedOptionError('group', 'ruby', ['python'])
  assert.equal(error.code, 'UNSUPPORTED_OPTION')
  assert.equal(error.option, 'group')
  assert.equal(error.message, 'Unsupported group "ruby"; allowed values: python.')
})
