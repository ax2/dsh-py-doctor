# dsh-py-doctor

> 离线、确定性的 Python / Django 生产报错诊断工具集，为 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-tools) 提供 6 个工具。
> Deterministic, offline Python/Django production-report diagnostics for DeepSeek Harness.

把线上报错原文粘进来，拿回结构化结论：异常类型、调用链、N+1 查询、未执行的 migration、`check --deploy` 项、Celery 任务堆积。
**一句话：纯本地、零网络、有界、可复现。**
本插件不执行 Python、不起子进程、不读文件、不连网络、不看时钟、不用随机数——每个工具都是输入的纯函数；
输入超预算就拒绝（不截断），看不懂的行如实列进 `unknown_lines`（不静默丢弃）。

---

## 快速开始

[![npm](https://img.shields.io/npm/v/dsh-py-doctor)](https://www.npmjs.com/package/dsh-py-doctor)
![tools](https://img.shields.io/badge/tools-6-blue) ![tests](https://img.shields.io/badge/tests-75%20passing-brightgreen) ![network](https://img.shields.io/badge/network-none-informational) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

```sh
dsh plugin --profile web add dsh-py-doctor
```

装完**重启应用**（bundle 列表是启动时读的）。想一次装齐四个插件（含 [deterministic-tools](https://github.com/ax2/dsh-deterministic-tools) / [jvm-doctor](https://github.com/ax2/dsh-jvm-doctor) / [win-native](https://github.com/ax2/dsh-win-native)）用 [`@ax2zicode/dsh-dev-toolbox`](https://github.com/ax2/dsh-dev-toolbox)；**别和单独安装混用**。

**家族总览**：[zicode.com/software](https://zicode.com/software/) 是四个插件、合装包与桌面软件的统一入口。

**15 秒看效果** —— 把 traceback 贴进去，模型调用 `python_traceback`，拿回（实测输出）：

```
exception_type: KeyError            message: 'user_id'
deepest_frame:  svc.py:42 in handle
cause_hint:     The mapping has no key 'user_id'; production data is usually
                missing the key that test data always has.
coverage:       3/3 lines, 0 unknown, confidence 1 (parser tb-1)
```

**为什么不让模型自己写 pwsh？** 它读得懂 traceback，但给不了这个：
- **覆盖率**：未识别的行（`unknown_lines`）逐条列出，而不是被静默丢掉；
- **一次就对**：`__cause__` / `__context__` 链、SyntaxError 的 caret 行列、`[Previous line repeated N more times]` 都有 75 个测试盯着；
- **不吃幻觉**：pytest / migrations / checks / celery 的每个数字都能追溯到原文行。

相邻插件：[dsh-deterministic-tools](https://github.com/ax2/dsh-deterministic-tools) · [dsh-jvm-doctor](https://github.com/ax2/dsh-jvm-doctor) · [dsh-win-native](https://github.com/ax2/dsh-win-native) · [dsh-dev-toolbox](https://github.com/ax2/dsh-dev-toolbox)

---

## 中文说明

### 它解决什么问题

线上事故发生时的典型流程是：从日志里复制一段 traceback / pytest 输出 / `showmigrations` 结果粘到对话里，然后靠人眼找关键行。
这个过程有三个常见失败：抄错行号、漏掉后面真正的根因、把"看不懂的日志"当成"已经看懂了"。

`dsh-py-doctor` 只做一件事：把这六类**已知语法**的报告文本解析成结构化 JSON，并且**如实报告它读懂了多少**。

### 为什么坚持离线

- **可复现**：同一段输入永远得到同一份输出。没有时钟、没有随机、没有网络，所以结论可以进 issue、进 CI、进复盘文档。
- **可审计**：工具不接触你的服务器，不需要 `settings.py`、不需要数据库连接串、不需要 `-A proj`。粘文本就够了。
- **不失真**：不在本地跑一遍 Django 来"确认"，就不会引入第二套环境差异。
- **无副作用**：绝不 `migrate`、绝不发查询、绝不重启 worker。

### 安装

npm（推荐）：

```bash
dsh plugin --profile web add dsh-py-doctor      # 装进 profile
```

预构建 tarball（与 npm 上是同一份产物，无需构建步骤）：

```bash
dsh plugin --profile web add https://github.com/ax2/dsh-py-doctor/releases/latest/download/dsh-py-doctor.tgz
```

要固定版本就把 `latest/download/dsh-py-doctor.tgz` 换成 `download/v<version>/dsh-py-doctor-<version>.tgz`。

包内 `cordis.patch.yml` 会往 profile 的 bundle 列表里插入一行 `id: py-doctor`，DSH 加载 profile 时即注册这 6 个工具。
本地开发时不必发布，直接挂载构建产物：

```bash
pnpm install && pnpm build
dsh --profile web --patch ./cordis.local-overlay.yml --dump-config   # 先验证层合成
dsh --profile web --patch ./cordis.local-overlay.yml                 # 再启动
```

```yaml
# cordis.local-overlay.yml
- insert:
    - id: py-doctor-local
      name: 'D:/dsh/dsh-py-doctor/lib/index.js'
```

分发使用预构建产物（`lib/`），**没有** `postinstall` / `prepare` 脚本。

### 六个工具

所有工具都在 `python` 组内，参数都是 `text`（报错原文，必填，内联粘贴）。返回值统一为回执信封：

```json
{ "result": { "...": "..." }, "meta": { "bytesIn": 412, "bytesOut": 987, "truncated": false, "notes": ["parse coverage 100.0% ..."] } }
```

| 工具 | 读什么 | 不读什么 |
|---|---|---|
| `python_traceback` | CPython traceback：异常类型/模块/消息、帧链、`__cause__`/`__context__` 链、SyntaxError 的插入符号（caret）行号与列、`[Previous line repeated N more times]`、project 与 site-packages 帧、常见异常的根因提示 | 非 traceback 的散文；截断的 `Traceback (most recent call last` 会被判为未识别 |
| `pytest_summary` | pytest 计数（passed/failed/errors/skipped/xfailed/xpassed/warnings/deselected）、耗时、`FAILURES`/`ERRORS` 段落与 `E ` 断言摘要、`short test summary info`、`--durations` 最慢用例 | 本次运行没打印的段落（在 `warnings` 里点名，不猜测） |
| `django_migrations` | `showmigrations` 缩进列表、`--plan` 平铺列表、`app (database)` 库横幅、`(no migrations)`、每 app 已应用/未应用与总数、`plan_needed` | `--plan` 没有勾选框，所以不会把任何一条说成"已应用" |
| `django_sql_n_plus_one` | 按归一化语句分组重复查询（归一化会折叠空白、把字符串/数字/`%s`/参数元组换成 `?`），给出 N+1 候选、次数、动词、表名、一条原始样例 | 归一化是有损的（只差常量的语句会合并），所以样例永远保留；不发任何查询 |
| `django_checks` | `manage.py check` / `check --deploy`：每条 finding 的级别、诊断 id（`fields.W161`）、消息、`HINT`、尽力提取的对象、各级计数、`?:` 部署清单项、`System check identified ...` 汇总 | 汇总数字与解析出的 finding 数不一致时，两边都报出来，不替任何一边圆场 |
| `celery_report` | `inspect active/reserved/ping/stats`：worker 名、任务条目与直方图、reserved 段、`worker_count` 之类的事实键 | 纯 `inspect active` 无法与 `inspect reserved` 区分，只有显式 `'reserved':` 段才会计入 `reserved_tasks` |

### 例：`python_traceback`

输入（节选）：

```
Traceback (most recent call last):
  File "/srv/app/shop/views.py", line 12, in post
    return self.helper(request)
  File "/usr/local/lib/python3.12/site-packages/django/db/models/query.py", line 448, in get
    raise self.model.DoesNotExist(
shop.models.Order.DoesNotExist: Order matching query does not exist.
```

输出（节选，`json` 已裁剪）：

```json
{
  "result": {
    "exception_type": "DoesNotExist",
    "exception_module": "shop.models.Order",
    "exception_message": "Order matching query does not exist.",
    "frames": [
      { "file": "/srv/app/shop/views.py", "line": 12, "function": "post", "origin": "project" },
      { "file": "/usr/local/lib/python3.12/site-packages/django/db/models/query.py", "line": 448, "function": "get", "origin": "installed" }
    ],
    "deepest_project_frame": { "file": "/srv/app/shop/views.py", "line": 12, "function": "post" },
    "coverage": { "total_lines": 6, "parsed_lines": 6, "unknown_count": 0, "confidence": 1, "parser_version": "tb-1" }
  },
  "meta": { "bytesIn": 313, "bytesOut": 1692, "truncated": false, "notes": ["parse coverage 100.0% (6/6 recognized lines, 0 unknown, parser tb-1)"] }
}
```

### 例：`django_sql_n_plus_one`

输入：

```
(0.004) SELECT "shop_product"."id" FROM "shop_product" WHERE "shop_product"."order_id" = 11 LIMIT 21; args=(11,)
(0.001) SELECT "shop_product"."id" FROM "shop_product" WHERE "shop_product"."order_id" = 12 LIMIT 21; args=(12,)
(0.001) SELECT "shop_product"."id" FROM "shop_product" WHERE "shop_product"."order_id" = 13 LIMIT 21; args=(13,)
```

输出（节选）：`candidates[0]` 为

```json
{
  "normalized": "SELECT \"shop_product\".\"id\" FROM \"shop_product\" WHERE \"shop_product\".\"order_id\" = ? LIMIT ?",
  "count": 3,
  "verb": "SELECT",
  "tables": ["shop_product"],
  "example": "SELECT \"shop_product\".\"id\" FROM \"shop_product\" WHERE \"shop_product\".\"order_id\" = 11 LIMIT 21; args=(11,)",
  "first_line": 1,
  "lines": [1, 2, 3],
  "n_plus_one": true
}
```

### 诚实回执（coverage receipt）

每份结果都带 `coverage`：

| 字段 | 含义 |
|---|---|
| `total_lines` | 提交文本的物理行数 |
| `parsed_lines` | 被某条语法规则认领的行数 |
| `unknown_count` | 非空、且没有任何规则认领的行数 |
| `unknown_lines` | 最多 8 条未识别行样例（每条最长 200 字符 + 省略号），带行号 |
| `unknown_truncated` | 是否还有更多未识别行没放进样例 |
| `confidence` | `parsed / (parsed + unknown)`，保留 3 位小数；空行不计入分母；空输入视为 1 |
| `parser_version` | 语法版本号（`tb-1`、`pytest-1`、`migrations-1`、`sql-1`、`checks-1`、`celery-1`） |

结论：**`confidence` 不是"我有多确定"，而是"你粘进来的实质内容我读懂了多大比例"。**
未识别的行不会消失，它们出现在 `unknown_lines` 里，并让 `confidence` 掉下来。
例：把 `*** worker 7 restarting after SIGKILL ***` 插到某个 frame 的 `File "..."` 行和它的源码行之间，
它会以 `{ line: 3, text: "*** worker 7 restarting after SIGKILL ***" }` 出现在 `unknown_lines[0]`，
后面的真实源码行同样被判为未识别（源码行必须紧跟自己的 frame 行，且带 CPython 的四空格缩进），
`confidence` 从 1 掉到 0.6——**它绝不会被当成 frame 的源码吸收掉**。

### 预算与拒绝

`apply(ctx, config)` 接受以下配置（全部可选，含默认值；DSH 从 profile 的插件配置传入，也就是挂在 `py-doctor` 这个 id 下的那段对象）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `maxInputBytes` | 262144 | **硬上限**：超过就抛 `INPUT_TOO_LARGE`，不回半个结果 |
| `maxFrames` | 200 | traceback 帧数上限（同时修正 `deepest_frame` 指针） |
| `maxFailures` | 100 | pytest 失败/错误/摘要条目上限 |
| `maxFindings` | 200 | `check` finding 上限 |
| `maxQueryGroups` | 500 | 归一化 SQL 分组上限 |
| `maxTaskEntries` | 500 | Celery 任务条目上限 |
| `minRepeats` | 3 | N+1 判定阈值（`django_sql_n_plus_one` 还可用 `min_repeats` 参数按次覆盖，最小 2） |
| `toolPrefix` | `""` | 工具名前缀，`py` → `py__python_traceback` |
| `only` | `[]` | 只注册列出的工具名，空表示全部 |

结构化输入超预算的行为是**拒绝**而不是截断：`BoundedInputError`（`code: "INPUT_TOO_LARGE"`）会说明实测字节数、上限、以及"没有截断也没有部分处理"。
列表类结果超上限则**截断并标注**：`meta.truncated === true`，`meta.notes` 写明是哪个上限，渲染文本会出现 `[bounded] input=…B output=…B` 尾注。
参数类型不对（例如 `min_repeats: "lots"`）由工具参数 schema 直接拒绝（`INVALID_ARGS`），不会静默降级成默认值。

### 路线图

- **0.1.0（当前）**：六个解析工具 + 诚实回执 + 预算拒绝 + 75 个测试（含刻意截断/乱码样例）。
- **0.2.0**：Django `explain`/`EXPLAIN ANALYZE` 输出解析（离线读文本，仍不连库）；pytest `--tb=long` 的源码位置精确化；`pip check` / `pipdeptree` 依赖冲突解析。
- **0.3.0**：跨报告关联（traceback 的 `file:line` 与 pytest 失败位置对齐）；`gunicorn`/`uwsgi` worker 崩溃日志；`opentelemetry` span dump 的最小可用解析。
- **不做**：执行 Python、连数据库、连网络、读文件系统、调用 `manage.py`。这些交给别的工具，代价是环境不可复现。

### 开发

```bash
pnpm install
pnpm typecheck     # tsc -p tsconfig.json --noEmit
pnpm test          # node --test --experimental-strip-types test/*.test.ts
pnpm build         # tsc -p tsconfig.build.json → lib/
```

- 源码只用 Node 的 **strip-only** TypeScript 子集：没有 `enum`、没有 `namespace`、没有构造函数参数属性、没有装饰器；相对导入必须带 `.ts` 后缀。
- `src/core/*.ts` 是纯解析器（一模块一报告族），`src/tools.ts` 只做参数/回执/预算装配。
- 测试用例数 ≥ 工具数，并且断言**精确数字**（行号、计数、`confidence` 三位小数），不用 `truthy` 糊过去。

### 许可

MIT，版权归 `ax2`。

---

## English

### What it is

`dsh-py-doctor` registers six DeepSeek Harness tools that turn pasted Python/Django
production output into structured JSON. Every tool is a pure function of its input:
**no Python execution, no subprocess, no filesystem, no network, no clock, no randomness.**

| Tool | Input | Structured result |
|---|---|---|
| `python_traceback` | CPython traceback text | exception type/module/message, frame chain, chained causes, SyntaxError caret line and column, elided recursion, project vs installed frames, root-cause hints |
| `pytest_summary` | `pytest -q -ra --durations` output | counter totals, duration, failure/error sections with `file:line` and `E ` excerpts, short-summary entries, slowest tests |
| `django_migrations` | `manage.py showmigrations` / `--plan` | per-app applied and unapplied names, counts, apps needing a plan, `(no migrations)` apps, `plan_needed` |
| `django_sql_n_plus_one` | `connection.queries` dump, debug-toolbar SQL panel, `-v2` query log | normalized statement groups, N+1 candidates with count, verb, tables, first line and one original example |
| `django_checks` | `manage.py check` / `check --deploy` | one finding per issue with level, diagnostic id, message, hint, best-effort object, per-severity counts, deploy items, summary line |
| `celery_report` | `celery inspect active/reserved/ping/stats` | workers with task lists, task histogram, reserved tasks, scalar facts |

### Why offline only

Reproducibility and auditability. The same paste always produces the same JSON, so a
diagnosis can be pasted into an issue, a CI log, or a post-mortem. Nothing needs your
`settings.py`, a database URL, or `-A proj`; nothing can migrate, query, or restart a
worker as a side effect of asking a question. The cost is explicit: this plugin will
never confirm a hypothesis by running your code.

### Example: `python_traceback`

Input:

```
Traceback (most recent call last):
  File "/srv/app/shop/views.py", line 12, in post
    return self.helper(request)
  File "/usr/local/lib/python3.12/site-packages/django/db/models/query.py", line 448, in get
    raise self.model.DoesNotExist(
shop.models.Order.DoesNotExist: Order matching query does not exist.
```

Output (trimmed):

```json
{
  "result": {
    "exception_type": "DoesNotExist",
    "exception_module": "shop.models.Order",
    "exception_message": "Order matching query does not exist.",
    "deepest_project_frame": { "file": "/srv/app/shop/views.py", "line": 12, "function": "post" },
    "coverage": { "total_lines": 6, "parsed_lines": 6, "unknown_count": 0, "confidence": 1, "parser_version": "tb-1" }
  },
  "meta": { "bytesIn": 313, "bytesOut": 1692, "truncated": false, "notes": ["parse coverage 100.0% (6/6 recognized lines, 0 unknown, parser tb-1)"] }
}
```

Every tool returns this `{ result, meta }` envelope. `meta.notes` always opens with the
coverage receipt; anything clipped adds a `[bounded]` / `[note]` footer to the rendered
text rather than silently shrinking the payload.

### Install

```bash
dsh plugin --profile web add dsh-py-doctor      # npm
```

Or pin the prebuilt tarball (the same artifact, for offline installs):
`https://github.com/ax2/dsh-py-doctor/releases/latest/download/dsh-py-doctor.tgz` (or
`download/v<version>/dsh-py-doctor-<version>.tgz` to pin a version)

Verified end to end: the published package was installed from npm into a scratch profile
and a real model turn called `python_traceback` on a three-line traceback, returning
`exception_type`, the frame list and 100% parse coverage (`session-b5681b93`).

The packaged `cordis.patch.yml` inserts one bundle row (`id: py-doctor`), so loading the
profile registers all six tools. Locally you can skip publishing and mount the build
output with `dsh --profile web --patch ./cordis.local-overlay.yml`, where the overlay
inserts `{ id: py-doctor-local, name: 'D:/dsh/dsh-py-doctor/lib/index.js' }`. Distribution
uses the prebuilt `lib/`; there is no `postinstall` or `prepare` script.

### Example: a refusal

An input above `maxInputBytes` is **refused**, never partially parsed:

```
BoundedInputError: report is 300000 UTF-8 bytes, above the configured limit of 262144 bytes.
Split the report and call the tool again; nothing was truncated or partially processed.
```

### The coverage receipt

`confidence` is not a confidence in the diagnosis; it is the share of *substantive* input
lines a grammar rule claimed: `parsed / (parsed + unknown)`, rounded to three decimals,
with blank lines excluded from the denominator and an empty input reported as `1`.
Unrecognized lines are listed in `unknown_lines` (up to 8 samples of at most 200
characters, with their line numbers) and lower the number. Nothing is dropped quietly:
paste `*** worker 7 restarting after SIGKILL ***` between a frame's `File "..."` line and
its source line and it is reported as
`unknown_lines[0] = { line: 3, text: "*** worker 7 restarting after SIGKILL ***" }` — the
real source line below it is reported as unrecognized too, because a source line has to
hang directly off its frame with CPython's four-space indent — and `confidence` drops
from `1` to `0.6`. It is never absorbed as the frame's source.

### Configuration

`apply(ctx, config)` accepts these optional fields, passed by DSH from the profile
configuration under the plugin id:

```yaml
maxInputBytes: 262144   # hard ceiling; over-budget input is refused
maxFrames: 200
maxFailures: 100
maxFindings: 200
maxQueryGroups: 500
maxTaskEntries: 500
minRepeats: 3
toolPrefix: ''          # 'py' registers py__python_traceback, ...
only: []                # ['celery_report'] registers just that tool
```

`maxInputBytes` is a refusal threshold. The list caps (`maxFrames`, `maxFailures`,
`maxFindings`, `maxQueryGroups`, `maxTaskEntries`) clip and set `meta.truncated = true`
with a named note. `maxOutputBytes` is retained in the config for interface
compatibility; structured results are bounded by the list caps and the input budget
instead, so it currently acts as a declared-but-unused ceiling.

### Roadmap

- **0.1.0**: the six parsers, the receipt envelope, budget refusals, 75 tests including
  deliberately truncated and garbled fixtures.
- **0.2.0**: `EXPLAIN` text parsing (still offline), precise source locations for
  `--tb=long`, `pip check` / `pipdeptree` conflict parsing.
- **0.3.0**: cross-report correlation (traceback `file:line` against pytest failure
  locations), `gunicorn`/`uwsgi` worker crash logs, minimal OpenTelemetry span dumps.
- **Never**: executing Python, connecting to a database, network access, filesystem
  access, invoking `manage.py`.

### Development

```bash
pnpm install
pnpm typecheck   # tsc -p tsconfig.json --noEmit
pnpm test        # node --test --experimental-strip-types test/*.test.ts
pnpm build       # tsc -p tsconfig.build.json → lib/
```

Source uses only Node's strip-only TypeScript subset (no `enum`, no `namespace`, no
constructor parameter properties, no decorators) and `.ts`-suffixed relative imports.
`src/core/*.ts` holds one pure parser per report family; `src/tools.ts` only wires
parameters, receipts, and budgets. Tests assert exact numbers rather than truthiness, and
the suite is at least as large as the tool count.

### License

MIT, copyright `ax2`.
