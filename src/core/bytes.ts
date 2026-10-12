/**
 * UTF-8 byte accounting, hard input bounds, and lossless text clipping.
 *
 * Framework-agnostic on purpose: every rule here is testable without a DSH host
 * and reusable by any surface that embeds these tools. Copied from the reference
 * suite so this package has zero cross-repo runtime coupling.
 * @module dsh-py-doctor/core/bytes
 */

/** Raised when a payload exceeds the configured input budget. */
export class BoundedInputError extends Error {
  /** Stable, machine-readable failure code. */
  readonly code = 'INPUT_TOO_LARGE'
  /** Measured UTF-8 size of the rejected payload. */
  readonly actualBytes: number
  /** Configured ceiling in UTF-8 bytes. */
  readonly limitBytes: number

  /**
   * @param actualBytes - measured UTF-8 size of the rejected payload.
   * @param limitBytes - configured ceiling in UTF-8 bytes.
   * @param what - short label for the payload, used in the message.
   */
  constructor(actualBytes: number, limitBytes: number, what = 'input') {
    super(
      `${what} is ${actualBytes} UTF-8 bytes, above the configured limit of ${limitBytes} bytes. ` +
        'Split the report and call the tool again; nothing was truncated or partially processed.',
    )
    this.name = 'BoundedInputError'
    this.actualBytes = actualBytes
    this.limitBytes = limitBytes
  }
}

/** Raised when a requested operation or option value is not supported. */
export class UnsupportedOptionError extends Error {
  /** Stable, machine-readable failure code. */
  readonly code = 'UNSUPPORTED_OPTION'
  /** The option name that carried the bad value. */
  readonly option: string

  /**
   * @param option - the option name that carried the bad value.
   * @param value - the unsupported value.
   * @param allowed - permitted values.
   */
  constructor(option: string, value: unknown, allowed: readonly string[]) {
    super(`Unsupported ${option} ${JSON.stringify(value)}; allowed values: ${allowed.join(', ')}.`)
    this.name = 'UnsupportedOptionError'
    this.option = option
  }
}

/** UTF-8 byte length of a string. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** UTF-8 byte length of any canonical JSON value. */
export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? '')
}

/**
 * Measure a payload and refuse it when it exceeds the budget.
 * @param text - payload to measure.
 * @param limitBytes - configured ceiling.
 * @param what - label used in the error message.
 * @returns the measured byte length when the payload fits.
 */
export function assertWithinInput(text: string, limitBytes: number, what = 'input'): number {
  const bytes = utf8Bytes(text)
  if (bytes > limitBytes) throw new BoundedInputError(bytes, limitBytes, what)
  return bytes
}

/**
 * Clip a string to a byte budget without splitting a code point.
 * @param text - source string.
 * @param maxBytes - byte ceiling.
 * @returns the clipped text, its byte length, and whether clipping happened.
 */
export function clipToBytes(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const total = utf8Bytes(text)
  if (total <= maxBytes) return { text, bytes: total, truncated: false }
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = utf8Bytes(ch)
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return { text: out, bytes: used, truncated: true }
}

/**
 * Clip an array to a maximum number of entries.
 * @param items - source array.
 * @param maxItems - entry ceiling.
 * @returns the clipped array and whether clipping happened.
 */
export function clipItems<T>(items: readonly T[], maxItems: number): { items: T[]; truncated: boolean } {
  if (items.length <= maxItems) return { items: [...items], truncated: false }
  return { items: items.slice(0, maxItems), truncated: true }
}

/**
 * Split a report into lines while remembering 1-based line numbers.
 *
 * A trailing newline must not invent a phantom empty line, otherwise coverage
 * denominators drift between a file that ends with `\n` and one that does not.
 * @param text - report text.
 * @returns array of `[lineNumber, text]` pairs.
 */
export function numberedLines(text: string): { number: number; text: string }[] {
  const raw = text.split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  return raw.map((line, index) => ({ number: index + 1, text: line.endsWith('\r') ? line.slice(0, -1) : line }))
}
