/**
 * CPython traceback parser.
 *
 * A production traceback is a stateful document: repeated `Traceback (most
 * recent call last):` headers separate exception blocks, the blocks are linked by
 * one of two English separator sentences, and the interpreter may elide the
 * middle of a recursion loop. This module reads that grammar without executing
 * anything and without guessing: anything the grammar does not cover is reported
 * through the coverage ledger instead of being dropped.
 * @module dsh-py-doctor/core/traceback
 */
import { numberedLines } from './bytes.ts'
import { CoverageLedger, type Coverage } from './coverage.ts'

/** Grammar revision of {@link parsePythonTraceback}. */
export const TRACEBACK_PARSER_VERSION = 'tb-1'

/** How the interpreter linked this exception block to the previous one. */
export type ChainKind = 'direct_cause' | 'during_handling' | 'none'

/** Where a frame's source file lives, as far as a path alone can prove. */
export type FrameOrigin = 'project' | 'installed' | 'stdlib' | 'unknown'

/** One `File "...", line N, in f` frame. */
export interface TracebackFrame {
  /** Source file path exactly as printed. */
  file: string
  /** Line number as printed, or `null` when the interpreter omitted it. */
  line: number | null
  /** Function or `<module>`. */
  function: string
  /** Verbatim source line, or `null` when the interpreter printed none. */
  source: string | null
  /** Heuristic classification of {@link file}. */
  origin: FrameOrigin
  /** `true` when the file looks like an installed third-party package. */
  installed: boolean
  /** Repetitions elided by `[Previous line repeated N more times]`. */
  repeated: number
}

/** `SyntaxError` / `IndentationError` caret diagnostics. */
export interface SyntaxDetail {
  /** 1-based column of the first caret, or `null`. */
  offset: number | null
  /** Number of caret characters printed. */
  pointer_length: number
  /** 1-based source line the carets refer to, or `null` when unknown. */
  line_number: number | null
  /** Source text to the left of the carets. */
  left: string
  /** Source text under the carets, or the raw caret run when no source line was printed. */
  middle: string
  /** Source text to the right of the carets. */
  right: string
}

/** One exception block: one header, its frames, and its exception line. */
export interface ExceptionBlock {
  /** 1-based line of the `Traceback (most recent call last):` header. */
  header_line: number
  /** How this block was linked to the block printed above it. */
  chain: ChainKind
  /** Frames in print order (outermost caller first). */
  frames: TracebackFrame[]
  /** Exception class name, or the bare tail of a module-qualified name. */
  exception_type: string
  /** The module path printed before the final dot, when there was one. */
  exception_module: string | null
  /** Text after the first `: `, or `''`. */
  exception_message: string
  /** Additional message lines the interpreter wrapped or formatted. */
  message_lines: string[]
  /** Caret diagnostics, for `SyntaxError` and friends only. */
  syntax: SyntaxDetail | null
  /** `true` when the interpreter elided recursion inside this block. */
  truncated: boolean
}

/** A one-line, actionable reading of the outermost exception. */
export interface CauseHint {
  /** Exception type the hint applies to. */
  exception_type: string
  /** One-sentence diagnosis. */
  hint: string
  /** Concrete next actions, in priority order. */
  suggestions: string[]
}

/** Result of {@link parsePythonTraceback}. */
export interface TracebackReport {
  /** Exception type of the outermost exception, or `null` when nothing parsed. */
  exception_type: string | null
  /** Module path printed before the outermost exception name, or `null`. */
  exception_module: string | null
  /** Message of the outermost exception, or `null`. */
  exception_message: string | null
  /** Every exception block, oldest first. */
  blocks: ExceptionBlock[]
  /** The type of each block that named one, oldest first — the cause chain as printed. */
  chain: string[]
  /** Flat frame list across every block, in print order. */
  frames: TracebackFrame[]
  /** Last frame of the outermost block. */
  deepest_frame: TracebackFrame | null
  /** Last project frame of the outermost block, when there is one. */
  deepest_project_frame: TracebackFrame | null
  /** Wall-clock seconds the request took, when the log printed `Time: N seconds`. */
  elapsed_seconds: number | null
  /** Up to three hints for the outermost exception type. */
  cause_hints: CauseHint[]
  /** Non-fatal problems worth telling the model about. */
  warnings: string[]
  /** Coverage receipt for this parse. */
  coverage: Coverage
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu
const TRACEBACK_HEADER = 'Traceback (most recent call last):'
const DIRECT_CAUSE = 'The above exception was the direct cause of the following exception:'
const DURING_HANDLING = 'During handling of the above exception, another exception occurred:'
/**
 * `  File "path", line N, in f`, and the syntax-error variant `  File "path",
 * line N` where CPython omits the function because the file never compiled.
 */
const FILE_LINE = /^ {2}File "(?<file>.*)", line (?<line>\d+)(?:, in (?<func>.*))?$/u
const FILE_CONTINUATION = /^(?<rest>.*)", line (?<line>\d+), in (?<func>.*)$/u
const REPEAT = /^\[Previous line repeated (?<times>\d+) more times\]$/u
/**
 * The source excerpt CPython prints under a frame: its own four-space indent,
 * then code. Caret rows (`             ^^^^`) and log framing that lands inside a
 * traceback fail this rule, so they are reported as unrecognized instead of
 * being attributed to the frame above them.
 */
const SOURCE_LINE = /^ {4}(?<source>(?![ \t]*\^)\S.*)$/u
const ELAPSED = /^Time: (?<seconds>\d+(?:\.\d+)?) seconds?$/u
const LOG_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u
/**
 * Exception class names CPython and Django actually raise.
 *
 * Used for bare (colon-less) exception lines, so the list stays generous.
 */
const KNOWN_EXCEPTION = /(?:Error|Exception|Exit|Interrupt|Warning|StopIteration|StopAsyncIteration|KeyboardInterrupt|SystemExit|GeneratorExit|BaseException|ExceptionGroup|CancelledError|TimeoutError|Fault|WouldBlock|BrokenPipeError|AssertionError|NotImplementedError|RecursionError|MemoryError|UnicodeDecodeError|UnicodeEncodeError|ModuleNotFoundError|ImportError|AttributeError|KeyError|IndexError|TypeError|ValueError|RuntimeError|OSError|IOError|OperationalError|ImproperlyConfigured|DoesNotExist|MultipleObjectsReturned|ValidationError|PermissionDenied|Http404|DisallowedHost|SuspiciousOperation|FieldError|TemplateDoesNotExist|ProgrammingError|IntegrityError|InterfaceError|DatabaseError|DataError|InternalError|NotSupportedError)$/u
/**
 * Class-name shapes that may appear as `Name: message`.
 *
 * Deliberately narrower than {@link KNOWN_EXCEPTION}: a colon-introduced line is
 * only an exception when it reads like one, so log lines such as
 * `Traceback (most recent call last` are not promoted to exception types.
 */
const EXCEPTION_SHAPE = /(?:Error|Exception|Exit|Interrupt|Warning|Iteration|Fault|WouldBlock|Group)$/u
const EXCEPTION_LINE = /^(?<name>[A-Za-z_][\w.]*)(?:: *(?<message>[\s\S]*))?$/u
const BANNER_PREFIXES = [
  'Django version ',
  'Starting development server at',
  'Quit the server with',
  'Watching for file changes with StatReloader',
  'Performing system checks',
  'System check identified',
  'Operations to perform',
  'Running migrations',
  'Applying ',
  'No migrations to apply',
  'Python ',
  'Internal Server Error: ',
  'Bad Request: ',
  'Not Found: ',
]

/**
 * Parse a CPython traceback.
 *
 * Never throws: a report without any traceback header yields `exception_type:
 * null`, an empty block list, and a low-confidence coverage receipt.
 * @param text - report text, already decoded.
 */
export function parsePythonTraceback(text: string): TracebackReport {
  const lines = numberedLines(text)
  const ledger = new CoverageLedger()
  for (const line of lines) ledger.see(line.number, line.text)

  const blocks: ExceptionBlock[] = []
  const warnings: string[] = []
  let bannerCount = 0
  let elapsedSeconds: number | null = null
  let current: ExceptionBlock | null = null
  let pendingChain: ChainKind = 'none'
  let lastFrameLineNumber: number | null = null
  let caretSource: string | null = null
  /** 1-based source line the carets belong to, as the traceback itself printed it. */
  let caretLogicalLine: number | null = null
  /** 1-based line of the source text held in {@link caretSource}, for coverage. */
  let caretSourceLineNumber: number | null = null

  for (const { number, text: raw } of lines) {
    const text = raw.replace(ANSI, '').replace(/\s+$/u, '')
    const trimmed = text.trim()
    if (trimmed.length === 0) continue

    const elapsed = ELAPSED.exec(trimmed)
    if (elapsed !== null) {
      elapsedSeconds = Number(elapsed.groups?.seconds ?? '0')
      ledger.consume(number)
      continue
    }

    // The caret line belongs to the preceding source line, so it must be tested
    // before any rule that could claim it as prose.
    if (caretSource !== null && /^\s*\^/u.test(text)) {
      const block = current
      if (block !== null) {
        block.syntax = caretDetail(text, caretSource, caretLogicalLine)
      }
      if (caretSourceLineNumber !== null) ledger.consume(caretSourceLineNumber)
      ledger.consume(number)
      caretSource = null
      caretLogicalLine = null
      caretSourceLineNumber = null
      continue
    }

    if (trimmed === TRACEBACK_HEADER) {
      current = newBlock(number, pendingChain)
      blocks.push(current)
      pendingChain = 'none'
      lastFrameLineNumber = null
      caretSource = null
      caretLogicalLine = null
      caretSourceLineNumber = null
      ledger.recognize(number)
      continue
    }

    if (trimmed === DIRECT_CAUSE || trimmed === DURING_HANDLING) {
      pendingChain = trimmed === DIRECT_CAUSE ? 'direct_cause' : 'during_handling'
      if (current === null) {
        warnings.push(`line ${number}: exception separator printed before any traceback header`)
        bannerCount += 1
      } else {
        ledger.recognize(number)
      }
      continue
    }

    const repeat = REPEAT.exec(trimmed)
    if (repeat !== null) {
      const frame = lastFrameOf(current)
      if (frame !== null) {
        frame.repeated = Number(repeat.groups?.times ?? '0')
        const block = current
        if (block !== null) block.truncated = true
        ledger.recognize(number)
      } else {
        ledger.reject(number)
      }
      continue
    }

    const fileMatch = FILE_LINE.exec(text)
    if (fileMatch !== null) {
      const frame = makeFrame(
        fileMatch.groups?.file ?? '',
        Number(fileMatch.groups?.line ?? '0'),
        fileMatch.groups?.func ?? '<module>',
      )
      const block = current
      if (block === null) warnings.push(`line ${number}: frame printed outside any traceback header`)
      else block.frames.push(frame)
      lastFrameLineNumber = number
      caretSource = null
      // The caret syntax line is a continuation of this frame, so the frame's own
      // line number is the only truthful source line for the upcoming carets.
      caretLogicalLine = frame.line
      caretSourceLineNumber = null
      ledger.recognize(number)
      continue
    }

    // A file name containing a newline is printed as `File "...` on one line and
    // `name", line N, in f` on the next.
    if (lastFrameLineNumber === number - 1) {
      const continuation = FILE_CONTINUATION.exec(text)
      const frame = lastFrameOf(current)
      if (continuation !== null && frame !== null) {
        frame.file = `${frame.file}\n${continuation.groups?.rest ?? ''}`
        frame.line = Number(continuation.groups?.line ?? '0')
        frame.function = continuation.groups?.func ?? '<module>'
        const origin = classifyOrigin(frame.file)
        frame.origin = origin
        frame.installed = origin === 'installed'
        lastFrameLineNumber = number
        ledger.consume(number)
        continue
      }
    }

    // A source line is only a source line when it hangs directly off a frame and
    // carries CPython's own four-space indent. Anything else on the line after a
    // frame — a log stamp, a caret without source, prose — is not source code and
    // must not be absorbed as if it were.
    if (lastFrameLineNumber === number - 1) {
      const frame = lastFrameOf(current)
      const source = SOURCE_LINE.exec(text)
      if (frame !== null && frame.source === null && source !== null) {
        frame.source = source.groups?.source ?? ''
        caretSource = frame.source
        caretSourceLineNumber = number
        // The traceback's own `line N` is authoritative; a re-armed hint from an
        // exception note must not be overwritten by the physical line number.
        if (caretLogicalLine === null) caretLogicalLine = frame.line ?? number
        ledger.consume(number)
        continue
      }
    }

    const block = current
    if (block !== null && block.exception_type === '') {
      const parsed = parseExceptionLine(trimmed)
      if (parsed !== null) {
        block.exception_type = parsed.name
        block.exception_module = parsed.module
        block.exception_message = parsed.message
        ledger.recognize(number)
        continue
      }
      // Text between the last frame and the exception line belongs to neither,
      // so it is reported as unrecognized instead of being absorbed into the
      // message. Prose that follows the exception line is a continuation below.
      ledger.reject(number)
      continue
    }

    if (block !== null) {
      // `SyntaxError: ... (file.py, line 71)` and the trailing
      // `File "x.py", line 71` note both point at the offending source line;
      // that line is not part of the paste, so only the number is usable.
      const caretHint = /^File "(?<file>.*)", line (?<line>\d+)$/u.exec(trimmed)
      if (caretHint !== null) {
        const lineNumber = Number(caretHint.groups?.line ?? '0')
        caretSource = ''
        caretLogicalLine = lineNumber > 0 ? lineNumber : null
        caretSourceLineNumber = null
      }
      block.message_lines.push(trimmed)
      ledger.consume(number)
      continue
    }

    if (BANNER_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) || LOG_STAMP.test(trimmed)) {
      bannerCount += 1
      ledger.consume(number)
      continue
    }

    ledger.reject(number)
    if (process.env.DSH_PY_DOCTOR_TRACE === '1') process.stderr.write(`REJECT ${number} ${JSON.stringify(trimmed)}\n`)
  }

  if (current !== null && current.exception_type === '') {
    warnings.push(
      `traceback header on line ${current.header_line} has no exception line; frames were kept but the exception type is unknown`,
    )
  }

  const frames: TracebackFrame[] = []
  for (const block of blocks) frames.push(...block.frames)
  const outer = blocks.length > 0 ? (blocks[blocks.length - 1] ?? null) : null
  const outermost = outer !== null && outer.exception_type !== '' ? outer : null
  const deepestFrame = outer === null ? null : lastFrameOf(outer)
  const projectFrames = outer === null ? [] : outer.frames.filter((frame) => frame.origin === 'project')
  const deepestProjectFrame = projectFrames.length > 0 ? (projectFrames[projectFrames.length - 1] ?? null) : null

  if (blocks.length === 0) {
    warnings.push('no `Traceback (most recent call last):` header found; this input does not look like a CPython traceback')
  }
  if (bannerCount > 0) {
    warnings.push(`${bannerCount} surrounding log line(s) outside any traceback block were recognized and skipped`)
  }

  return {
    exception_type: outermost === null ? null : outermost.exception_type,
    exception_module: outermost === null ? null : outermost.exception_module,
    exception_message: outermost === null ? null : outermost.exception_message,
    blocks,
    chain: blocks.map((block) => block.exception_type).filter((name) => name !== ''),
    frames,
    deepest_frame: deepestFrame,
    deepest_project_frame: deepestProjectFrame,
    elapsed_seconds: elapsedSeconds,
    cause_hints: outermost === null ? [] : causeHints(outermost),
    warnings,
    coverage: ledger.coverage(TRACEBACK_PARSER_VERSION),
  }
}

/** Create an empty block for a header line. */
function newBlock(headerLine: number, chain: ChainKind): ExceptionBlock {
  return {
    header_line: headerLine,
    chain,
    frames: [],
    exception_type: '',
    exception_module: null,
    exception_message: '',
    message_lines: [],
    syntax: null,
    truncated: false,
  }
}

/** Last frame of a block, or `null` when the block has none. */
function lastFrameOf(block: ExceptionBlock | null): TracebackFrame | null {
  if (block === null || block.frames.length === 0) return null
  return block.frames[block.frames.length - 1] ?? null
}

/** Build a frame and classify its file. */
function makeFrame(file: string, line: number, fn: string): TracebackFrame {
  const origin = classifyOrigin(file)
  return {
    file,
    line: Number.isFinite(line) && line > 0 ? line : null,
    function: fn.length > 0 ? fn : '<module>',
    source: null,
    origin,
    installed: origin === 'installed',
    repeated: 0,
  }
}

/** Exception types that are followed by a caret diagnostic. */
function isSyntaxType(type: string): boolean {
  return type === 'SyntaxError' || type === 'IndentationError' || type === 'TabError'
}

/**
 * Classify a printed path from its shape alone.
 *
 * This is a heuristic and is documented as one: a project vendored inside
 * `site-packages`, or a project directory literally named `django`, will be
 * misread. `origin` therefore reports what the path proves, no more.
 * @param file - path exactly as printed.
 */
export function classifyOrigin(file: string): FrameOrigin {
  if (file.length === 0 || file.startsWith('<')) return 'unknown'
  const normalized = file.replace(/\\/gu, '/')
  if (/(^|\/)(site-packages|dist-packages)(\/|$)/u.test(normalized)) return 'installed'
  if (/(^|\/)lib\/python\d+(\.\d+)?\//u.test(normalized)) return 'stdlib'
  if (normalized.startsWith('/usr/lib/python') || normalized.startsWith('/usr/local/lib/python')) return 'stdlib'
  if (!normalized.includes('/')) return 'unknown'
  return 'project'
}

/** Split `module.Class: message` into its parts. */
function parseExceptionLine(text: string): { name: string; module: string | null; message: string } | null {
  const match = EXCEPTION_LINE.exec(text)
  if (match === null) return null
  const raw = match.groups?.name ?? ''
  if (raw.length === 0) return null
  const dot = raw.lastIndexOf('.')
  const name = dot >= 0 ? raw.slice(dot + 1) : raw
  const module = dot >= 0 ? raw.slice(0, dot) : null
  const hasMessage = match.groups?.message !== undefined
  // A bare class name must be an exception this package knows; a colon-introduced
  // name only has to be class-shaped. That rejects prose such as a truncated
  // `Traceback (most recent call last` without rejecting Django's own
  // `ImproperlyConfigured`/`DoesNotExist`, which are `Exception` subclasses but
  // match neither suffix rule.
  if (hasMessage) {
    if (!EXCEPTION_SHAPE.test(name) && !KNOWN_EXCEPTION.test(name) && !raw.includes('.')) return null
  } else if (!KNOWN_EXCEPTION.test(name)) {
    return null
  }
  return { name, module, message: match.groups?.message ?? '' }
}

/** Turn a caret line plus its source line into positioned diagnostics. */
function caretDetail(line: string, source: string, sourceLineNumber: number | null): SyntaxDetail {
  const indentLength = line.length - line.trimStart().length
  const markerRun = /^\s*(?<carets>\^+~*)/u.exec(line)
  const carets = markerRun?.groups?.carets ?? ''
  const pointerLength = carets.replace(/~/gu, '').length
  const left = source.slice(0, indentLength)
  const under = source.slice(indentLength, indentLength + pointerLength)
  return {
    offset: pointerLength > 0 ? indentLength + 1 : null,
    pointer_length: pointerLength,
    line_number: sourceLineNumber,
    left,
    middle: under.length > 0 ? under : carets,
    right: pointerLength > 0 ? source.slice(indentLength + pointerLength) : '',
  }
}

/** Best-effort root-cause hints for the exception types this package knows. */
export function causeHints(block: ExceptionBlock): CauseHint[] {
  const type = block.exception_type
  const message = block.exception_message
  const hints: CauseHint[] = []

  if (type === 'ModuleNotFoundError') {
    const missing = /No module named '(?<name>[^']+)'/u.exec(message)?.groups?.name ?? 'the named module'
    const top = missing.split('.')[0] ?? missing
    hints.push({
      exception_type: type,
      hint: `The interpreter could not import '${missing}'; the package is either absent from the active environment or imported under a different name than it is installed as.`,
      suggestions: [
        'Confirm the interpreter: a mismatched virtualenv is the most common cause (python -c "import sys; print(sys.executable)").',
        `Compare the distribution name with the import name for '${top}' (for example python-dotenv imports as dotenv).`,
        'Check that the settings module is on PYTHONPATH when manage.py runs from another directory.',
      ],
    })
  }

  if (type === 'ImportError') {
    const name = /cannot import name '(?<name>[^']+)'/u.exec(message)?.groups?.name ?? null
    hints.push({
      exception_type: type,
      hint:
        name === null
          ? 'The module was found but could not be imported; the failure is inside the import target, not in locating it.'
          : `'${name}' is not exported by the target module; usually a version skew between two pins, or a circular import.`,
      suggestions: [
        'Run the same import in a fresh interpreter to see the secondary error the application swallowed.',
        'Look for a local module shadowing an installed one (same file name on sys.path[0]).',
        'Check for a partially initialized module caused by a circular import.',
      ],
    })
  }

  if (type === 'AttributeError') {
    const attribute = /'(?<attr>[^']+)'/u.exec(message)?.groups?.attr ?? null
    const onObject = /'[^']+' object has no attribute/u.test(message)
    hints.push({
      exception_type: type,
      hint:
        attribute === null
          ? 'A name or attribute does not exist on the object the code reached at runtime.'
          : `'${attribute}' does not exist on that object${onObject ? '; this is typical of a version bump that renamed or removed an API' : ''}.`,
      suggestions: [
        'Print the concrete type at the failing frame before assuming the interface.',
        'Compare the installed package version with the version the code was written against.',
        'For lazy proxies (Django `SimpleLazyObject`), resolve the object before attribute access.',
      ],
    })
  }

  if (type === 'KeyError') {
    hints.push({
      exception_type: type,
      hint: `The mapping has no key ${message.trim().length > 0 ? message.trim() : '(printed above)'}; production data is usually missing the key that test data always has.`,
      suggestions: [
        'Use `.get()`/`.setdefault()` when the key is genuinely optional.',
        'When the key comes from an external payload, validate it at the boundary instead of deep in the call stack.',
      ],
    })
  }

  if (type === 'TypeError') {
    hints.push({
      exception_type: type,
      hint: `The call signature and the value disagree: ${message.trim().length > 0 ? message.trim() : 'see the message above'}.`,
      suggestions: [
        'A function gained or lost a positional parameter across a version bump.',
        '`None` reaching code that expects an iterable is the most frequent production variant of this error.',
      ],
    })
  }

  if (type === 'OperationalError' || type === 'ProgrammingError') {
    const missingTable = /no such table: (?<table>\S+)/u.exec(message)?.groups?.table ?? null
    const missingColumn = /no such column: (?<column>\S+)/u.exec(message)?.groups?.column ?? null
    const missingRelation = /relation "(?<relation>[^"]+)" does not exist/u.exec(message)?.groups?.relation ?? null
    const locked = /database is locked/u.test(message)
    hints.push({
      exception_type: type,
      hint: locked
        ? 'The database refused the write because another connection holds the lock; this is a concurrency symptom, not a schema symptom.'
        : missingTable !== null
          ? `Table '${missingTable}' does not exist in the connected database; migrations were applied somewhere else.`
          : missingColumn !== null
            ? `Column '${missingColumn}' does not exist; the code is newer than the migrated schema.`
            : missingRelation !== null
              ? `Relation '${missingRelation}' does not exist; the connected database is behind the code.`
              : 'The database rejected the statement; the message above is the driver’s own text.',
      suggestions: [
        'Compare the migration state with the database the process actually connected to (django_migrations rows).',
        missingTable !== null || missingColumn !== null || missingRelation !== null
          ? 'Re-run the deployment migration step and confirm it targeted this database alias.'
          : 'Increase the lock timeout only after confirming a competing writer.',
        'For SQLite in production, expect this class of error to be routine under concurrent writes.',
      ],
    })
  }

  if (type === 'RecursionError') {
    const repeating = block.frames.filter((frame) => frame.repeated > 0)
    hints.push({
      exception_type: type,
      hint:
        repeating.length > 0
          ? `The recursion limit was hit inside a repeated call; the interpreter elided the middle of the loop (${repeating.map((frame) => `${frame.function} x${frame.repeated}`).join(', ')}).`
          : 'The recursion limit was hit; the cycle is visible in the repeated function names above.',
      suggestions: [
        'Look for a serializer or a model `__repr__`/`__eq__` that walks a cyclic object graph.',
        'Django model instances reached through `related_name` back-references are the usual cycle.',
        'Raising `sys.setrecursionlimit` only moves the crash to the C stack: fix the cycle.',
      ],
    })
  }

  if (type === 'MemoryError') {
    hints.push({
      exception_type: type,
      hint: 'The process could not allocate more memory; the allocation shape and the container limit matter more than the trace itself.',
      suggestions: [
        'Find the unbounded materialization: `.all()` fed into `list(...)`, a DataFrame built from a whole table, or a cache with no max size.',
        'Switch the read to `.iterator()` or chunked `only()`/`values_list()` where the full set is not needed.',
        'Check the container memory limit before blaming the query plan.',
      ],
    })
  }

  if (isSyntaxType(type)) {
    const syntax = block.syntax
    hints.push({
      exception_type: type,
      hint:
        syntax === null || syntax.offset === null
          ? 'The file failed to compile; the caret line above is the interpreter’s own pointer.'
          : `The file failed to compile at column ${syntax.offset}; check for a stray bracket, a missing comma, or a tab/space mix on that line.`,
      suggestions: [
        'Reproduce with `python -m py_compile <file>` to confirm the failure is in the source and not in the import machinery.',
        'An unbalanced bracket or a trailing backslash on the previous line shifts the reported column.',
      ],
    })
  }

  return hints.slice(0, 3)
}
