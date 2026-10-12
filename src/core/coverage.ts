/**
 * Parser-coverage accounting: the honesty layer shared by every parser in this
 * package.
 *
 * A report parser that quietly drops the lines it does not understand is worse
 * than useless to a production debugger, because the missing lines are usually
 * the interesting ones. Every parser here must therefore declare, for each input
 * line, whether it recognized that line. Unrecognized non-blank lines become the
 * `unknown_lines` samples in the receipt, and `confidence` is the recognized
 * fraction over the parsed region.
 *
 * The parser version is a constant, not the package version, because the
 * coverage contract is what changes when a grammar rule is added or removed.
 * @module dsh-py-doctor/core/coverage
 */

/** One unrecognized, non-blank input line kept for the caller to inspect. */
export interface UnknownLine {
  /** 1-based line number in the submitted report. */
  line: number
  /** The verbatim line text, clipped to a short sample when very long. */
  text: string
}

/** The coverage receipt attached to every parsed report. */
export interface Coverage {
  /** Total physical lines in the submitted report. */
  total_lines: number
  /** Lines a grammar rule recognized. */
  parsed_lines: number
  /** Non-blank lines no grammar rule recognized. */
  unknown_count: number
  /** Up to {@link MAX_UNKNOWN_SAMPLES} unrecognized lines, in input order. */
  unknown_lines: UnknownLine[]
  /** `true` when unknown lines were dropped from the sample list. */
  unknown_truncated: boolean
  /**
   * `parsed_lines / (parsed_lines + unknown_count)`, rounded to 3 decimals.
   *
   * Blank lines and lines before the parsed region are excluded, so the number
   * answers "of the substantive lines I tried to read, how many did I read?".
   */
  confidence: number
  /** Grammar revision of the parser that produced this receipt. */
  parser_version: string
}

/** Longest verbatim fragment kept per unrecognized line. */
export const MAX_UNKNOWN_SAMPLE_CHARS = 200

/** How many unrecognized lines the receipt carries. */
export const MAX_UNKNOWN_SAMPLES = 8

/**
 * A per-line classification ledger.
 *
 * Usage: `for (const { number, text } of numberedLines(input)) { ledger.see(number); if (rule(text)) ledger.recognize(number) }`,
 * then `ledger.coverage(VERSION)`.
 */
export class CoverageLedger {
  /** Highest line number observed, i.e. the physical line count. */
  private totalLines = 0
  /** Recognized line numbers. */
  private readonly recognized = new Set<number>()
  /** Non-blank line numbers the parser explicitly rejected. */
  private readonly rejected = new Set<number>()
  /** Unrecognized line numbers, in input order. */
  private readonly unknown: number[] = []
  /** Verbatim text of every line offered to {@link see}. */
  private readonly texts = new Map<number, string>()

  /**
   * Record that a physical line exists and offer its text for later sampling.
   * @param number - 1-based line number.
   * @param text - verbatim line text.
   */
  see(number: number, text: string): void {
    if (number > this.totalLines) this.totalLines = number
    this.texts.set(number, text)
  }

  /**
   * Mark a line as recognized by a grammar rule.
   * @param number - 1-based line number.
   */
  recognize(number: number): void {
    this.recognized.add(number)
  }

  /**
   * Record that a line is part of a recognized construct even though no rule
   * matched it on its own — an exception message continuation, a caret, a
   * wrapped assertion excerpt. Without this, prose inside a recognized block
   * would be miscounted as a grammar failure.
   * @param number - 1-based line number.
   */
  consume(number: number): void {
    this.recognized.add(number)
  }

  /**
   * Mark a line as unrecognized. Blank lines are ignored on purpose: they carry
   * no syntax, so counting them as failures would understate confidence.
   * @param number - 1-based line number.
   */
  reject(number: number): void {
    if (this.recognized.has(number)) return
    const text = this.texts.get(number) ?? ''
    if (text.trim().length === 0) return
    this.rejected.add(number)
  }

  /**
   * Decide a whole region at once: every line in `[from, to]` that was not
   * explicitly recognized or consumed is judged by {@link reject}.
   * @param from - first line number of the region, inclusive.
   * @param to - last line number of the region, inclusive.
   */
  closeRegion(from: number, to: number): void {
    for (let number = from; number <= to; number += 1) this.reject(number)
  }

  /** Reported unknown-line count, without materializing the coverage object. */
  get unknownCount(): number {
    return this.unknown.length
  }

  /** Convenience: reject line `number` when `condition` is false. */
  rejectUnless(condition: boolean, number: number): void {
    if (!condition) this.reject(number)
  }

  /** Convenience: consume line `number` when `condition` is true. */
  consumeIf(condition: boolean, number: number): void {
    if (condition) this.consume(number)
  }

  /**
   * Materialize the coverage receipt.
   * @param parserVersion - grammar revision of the calling parser.
   */
  coverage(parserVersion: string): Coverage {
    for (const number of this.rejected) {
      if (this.recognized.has(number)) continue
      if (this.unknown.includes(number)) continue
      this.unknown.push(number)
    }
    this.unknown.sort((a, b) => a - b)
    this.rejected.clear()
    const samples: UnknownLine[] = []
    for (const number of this.unknown.slice(0, MAX_UNKNOWN_SAMPLES)) {
      samples.push({ line: number, text: sampleOf(this.texts.get(number) ?? '') })
    }
    const unknownCount = this.unknown.length
    const denominator = this.recognized.size + unknownCount
    const confidence = denominator === 0 ? 1 : Math.round((this.recognized.size / denominator) * 1000) / 1000
    return {
      total_lines: this.totalLines,
      parsed_lines: this.recognized.size,
      unknown_count: unknownCount,
      unknown_lines: samples,
      unknown_truncated: unknownCount > samples.length,
      confidence,
      parser_version: parserVersion,
    }
  }
}

/**
 * Shorten an unrecognized line for the receipt without splitting a code point.
 * @param text - verbatim line text.
 */
export function sampleOf(text: string): string {
  const trimmed = text.replace(/\s+$/u, '')
  const chars = [...trimmed]
  if (chars.length <= MAX_UNKNOWN_SAMPLE_CHARS) return trimmed
  return `${chars.slice(0, MAX_UNKNOWN_SAMPLE_CHARS).join('')}…`
}

/** The subset of {@link Coverage} the one-line coverage note is rendered from. */
export type CoverageSummary = Pick<Coverage, 'confidence' | 'parsed_lines' | 'unknown_count' | 'parser_version'>

/**
 * Render a coverage receipt as the one-line note humans read first.
 * @param coverage - coverage receipt, or any object exposing its summary fields.
 */
export function coverageNote(coverage: CoverageSummary): string {
  return (
    `parse coverage ${(coverage.confidence * 100).toFixed(1)}% ` +
    `(${coverage.parsed_lines}/${coverage.parsed_lines + coverage.unknown_count} recognized lines, ` +
    `${coverage.unknown_count} unknown, parser ${coverage.parser_version})`
  )
}
