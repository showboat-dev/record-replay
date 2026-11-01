# Sprint 2 契约：CSV 批量执行 + 结果导出

> 用户场景：流程里已经有 `{{变量}}`（参数化接受过），手上有一张 200 行的表格，
> 想"一键把这张表的所有行都跑一遍"，并拿到「哪行成功/哪行失败/为什么」的结果表。
>
> 原则：**本地执行、行级隔离、失败不炸整批、结果可导出**（业务人员要能直接交给同事）。

---

## A. CSV 解析（`packages/studio/src/csv.ts`，纯函数）

```ts
export interface ParsedCsv {
  headers: string[]                      // trim 后；重名列自动 _2/_3
  rows: Array<Record<string, string>>    // 按 headers 对齐；缺列补 ''
  warnings: string[]                     // 列数不齐/空行跳过等
}
export function parseCsv(text: string, opts?: { maxRows?: number; maxBytes?: number }): ParsedCsv
```

要求：
- 支持 **UTF-8 BOM**、CRLF/LF、**引号字段**（`"a,b"`、`""` 转义、字段内换行）、**逗号/分号/制表符自动识别**（按表头行的分隔符出现次数选，默认逗号）；
- 跳过完全空行；列数不齐 → 补空 + 一条 warning（不报错）；
- 限制：默认 **≤2000 行**、**≤5MB**、表头 ≥1 列；超出抛带中文原因的 `CsvError`；
- 列名 trim + 去重（`name`、`name_2`）；
- 纯函数、零依赖（不新增包）、可单测（≥20 条）。

---

## B. 批量执行（`@rr/executor` 新增 `playBatch`）

```ts
export interface BatchRow {
  /** 已按变量名映射好的行数据（缺列补 ''） */
  values: Record<string, string>
  /** 原始行号（CSV 第几行数据，1-based），用于结果展示 */
  index: number
}

export interface BatchOptions {
  flow: Flow
  rows: BatchRow[]
  /** 默认 true */
  headless?: boolean
  /** 默认 false：某行失败后继续跑剩余行 */
  stopOnFailure?: boolean
  /** 行间隔（默认 0；企业系统可设 200–500ms 降低压力） */
  rowDelayMs?: number
  artifactsRoot?: string
  /** 登录态文件（每行 context 都带上） */
  storageStatePath?: string
  /** 每个 context 的 viewport 覆盖（默认 flow.meta.env.viewport） */
  viewport?: { width: number; height: number }
  onRow?: (result: BatchRowResult) => void
  signal?: AbortSignal
}

export interface BatchRowResult {
  index: number
  ok: boolean
  runId: string
  ms: number
  steps: StepResult[]
  failedStep?: { id: string; kind: string; code?: string; reason?: string }
  /** 失败行的 after 截图（artifacts 相对路径） */
  screenshot?: string
}

export interface BatchResult {
  total: number
  okCount: number
  failCount: number
  stopped: boolean
  rows: BatchRowResult[]
  totalMs: number
}
export function playBatch(opts: BatchOptions): Promise<BatchResult>
```

实现要求：
- **浏览器只启动一次**，每行新建 context（`storageStatePath` 存在时带上），行之间互不影响；
- 行级 artifacts：`artifacts/<flowId>/batches/<batchId>/row-<index>/...`（before/after 截图 + result.json + log.txt），行级失败不中断；
- `signal` 中断 → 返回已跑完的行，`stopped: true`；
- 某行 `renderStep` 抛 `VARIABLE_MISSING` 属于**行失败**（不是整批失败），`failedStep.reason` 写清缺哪个变量；
- 输出顺序与输入行顺序一致；进度通过 `onRow` 实时回调。

---

## C. Studio API

| 方法 | 路径 | body | 返回 |
|---|---|---|---|
| POST | `/api/flows/:file/batch/start` | `{ csvText, fileName?, mapping?: Record<string,string>, options?: { headless?, stopOnFailure?, rowDelayMs? } }` | `{ batchId, total, columns, mapping, missingVariables }` |
| GET | `/api/batches/:id` | — | `{ status, total, completed, okCount, failCount, rows, startedAt, finishedAt?, message? }` |
| POST | `/api/batches/:id/stop` | — | `{ ok: true }` |
| GET | `/api/batches/:id/export.csv` | — | `text/csv`（UTF-8 BOM，Excel 直接打开不乱码） |

- `mapping`：变量名 → CSV 列名；未传时按「变量名 == 列名」自动匹配（大小写不敏感、忽略空格）；映射后仍缺列的变量 → `missingVariables` 非空 → 400（提示"CSV 里缺少这些列，请重新映射"）；
- 行数据 = `flow.variables` 的每个 name 从 CSV 对应列取值（空字符串也算有值，不报缺变量）；
- batch 状态机：`running`（默认并发 1，按行顺序）→ `done` | `stopped` | `error`；
- 每行结果包含 `failedStep`（id/kind/错误码/人话原因）与失败截图 URL；
- 导出列：`行号 + 原 CSV 所有列 + 状态 + 失败步骤 + 失败原因 + 耗时ms`；
- 批次保存在内存（Studio 重启即丢），导出/结果以接口为准；不做持久化（v1 可接受）。

### 限制
- 列映射只支持「一个变量 ← 一列」，不做表达式/拼接；
- 不支持 xlsx（需要新依赖；请用户另存为 CSV）；
- 并发固定 1（业务系统怕压测/幂等风险），行间隔可调；
- 行数上限 2000、体积上限 5MB。

---

## D. Studio 前端交互

1. 流程选中且 `flow.variables.length > 0` 时，变量面板下方出现「批量运行（CSV）」按钮；
2. 弹窗：选择 `.csv` 文件（也支持粘贴文本）→ 预览前 5 行 + 列名；
3. 映射表：每行 = `变量名` → `<下拉：CSV 列>`（自动同名预选）；未匹配的变量红字提示；
4. 选项：`显示浏览器窗口`（默认关，批量跑得快）、`某行失败后继续`（默认开）、`行间隔 ms`（默认 0）；
5. 开始 → 进度条（completed/total、成功/失败数）+ 实时行列表（状态、失败原因、截图缩略图）→ 「停止」；
6. 完成 → 汇总（成功 N / 失败 M / 总耗时）+ 「导出结果 CSV」（下载）+ 「只看失败行」筛选。

错误降级：`/api/flows/:file/batch/start` 400 时在弹窗内联展示中文原因（缺列/CSV 太大）。

---

## E. 验收

- 单测：CSV 解析 ≥20 条；studio batch API 测试（临时目录+临时端口）覆盖 成功/失败/停止/导出/mapping 缺列/0 行；
- e2e（`e2e/batch-run.test.ts`）：fixture `/basic` 参数化流程 + 3 行 CSV → 批量跑 → 3/3 成功；1 行缺变量 → 该行失败且整批继续；导出 CSV 内容校验；
- 回归：全仓 typecheck/test/lint、现有 e2e 4 套、本地 harness 18/18 保持。
