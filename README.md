# rr — 网页操作录制回放引擎

录制一次用户操作，稳定回放 N 次；回放失败时按「L1 语义 → L2 指纹 → L3 视觉 → L4 AI」逐级兜底，并把修好的结果写回 trace。

```
录制（受控 Chromium）→ flow.json（IR）→ 回放（多级解析 + 校验）→ 失败 artifact → AI 自愈写回
```

## 快速开始

```bash
pnpm install
pnpm typecheck     # 0 error
pnpm test          # 单元测试
pnpm site          # 启动 fixture 测试站（:5173 / 跨域 :5174）
pnpm rr --help     # CLI
pnpm verify        # typecheck + test + lint（里程碑门槛）
```

## 目录

```
packages/
├─ schema/     IR 类型（zod 唯一真源）+ 读写/迁移/契约校验   ← 已完成
├─ recorder/   录制：事件采集 + 合流 + ElementRef + expect 推断
├─ resolver/   解析：ElementRef → Locator（L1/L2，L4 接口）
├─ executor/   执行：resolve → act → verify + artifact
├─ ai/         AI 兜底（OpenAI 兼容，默认关闭）
├─ harness/    回归集 runner + report
└─ cli/        rr record/play/inspect/harness
flows/         录制产物（IR）
artifacts/     运行产物（截图/快照/日志，gitignore）
docs/          架构契约（architecture.md）、spike 结论、analysis/ 研究归档
```

> 仓库只放产品代码。`fixtures/`（自建测试站）与 `e2e/`（端到端测试）是**本地测试脚手架**，
> 已在 `.gitignore` 中忽略、不随仓库分发（见文末「本地测试脚手架」）。

## 关键文档

- [docs/architecture.md](docs/architecture.md) —— 各包接口契约（并行开发以它为准）
- [docs/spikes.md](docs/spikes.md) —— closed shadow / iframe ref 的实测结论
- [docs/analysis/产品设计-录制回放-v0.1.md](docs/analysis/产品设计-录制回放-v0.1.md) —— v0.1 产品设计草案（历史归档）
- [docs/analysis/README.md](docs/analysis/README.md) —— 参考项目分析归档索引（`refs/` 克隆不随仓库分发）

## 状态（M0 + M1 已完成）

| 模块                                          | 状态 | 证据                                                                                 |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| IR（schema + 契约）                           | ✅   | 20 单测（含 closed shadow/canvas 坐标契约）                                          |
| 自建测试站（本地 `fixtures/`，未入库）        | ✅   | 18 个难场景路由（iframe/shadow/登录/上传下载…）+ 双端口跨域                          |
| Spike A/B（closed shadow / iframe ref）       | ✅   | `docs/spikes.md`（847 行，实测结论）                                                 |
| recorder                                      | ✅   | capture.js + 合流 + Node 侧候选校验 + closed shadow host/offset + iframe 链；67 单测 |
| resolver（L1 + L2）                           | ✅   | 34 单测；L2 抹掉语义候选后 4/4 命中；歧义 15% 拒绝猜测                               |
| executor                                      | ✅   | 协议 13 种 step；失败必产 artifact；71 单测 + 14 个真实浏览器冒烟                    |
| ai（默认关闭）                                | ✅   | 46 单测（mock fetch）；脱敏/护栏/缓存/ref 生命周期                                   |
| harness + CLI                                 | ✅   | 站点清单/统计/HTML 报告；`rr harness` 6 站 18/18 通过                                |
| 端到端验证（本地 `e2e/`，未入库）             | ✅   | 5 套 14 条：录制→回放 / 新能力 / 登录态 / 参数化 / CSV 批量                          |
| v0.2 新能力（标签页/对话框/下载/组合键/上传） | ✅   | 端到端 6/6；5 条 smoke flow 回放通过                                                 |

### 当前基线（`pnpm rr harness --runs 3 --sites local`）

```
6/11 站有 flow · 18/18 runs 100% 通过 · 42 步全部 L1
P50 93ms / P95 354ms
```

已录 flow：`basic` / `iframe-same` / `shadow-closed` / `controlled` / `custom-select` / `spa`。
待补：`iframe-cross` / `canvas`（需要坐标） / `virtual-list` / `upload-download` / `dialog` → M2。

## 真实站点验证（SauceDemo 完整下单链路）

`flows/public-saucedemo.json`：**12 步**（登录 → 加购 2 件 → 购物车 → 结算 → 填收货信息 → 完成），密码自动转成 `{{password}}` secret 变量。

| 验证                                                                             | 结果                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm rr play flows/public-saucedemo.json --runs 10 --var password=secret_sauce` | **10/10 次通过**，12/12 步，单次 ≈1.55s          |
| `RR_VAR_password=... pnpm rr harness --sites public --runs 3`                    | **3/3 通过**，36 步全部 L1，P50 89ms / P95 192ms |
| 破坏版（把所有语义候选替换成不存在的 css，强制降级）                             | **2/2 通过**，12/12 步全部由 L2 指纹接管         |

> 真实站点测试顺带抓到一个**只在 tsx 运行时才暴露的 bug**：esbuild `keepNames` 会在函数体里注入
> `__name(...)`，函数被 `page.evaluate` 序列化进页面后抛 `__name is not defined`，导致 L2 全挂。
> 已在 resolver/executor/recorder 三处注入页面级垫片修复（`NAME_KEEPALIVE_SOURCE`）。

## CSV 批量执行 + 结果导出（Sprint 2）

流程里有 `{{变量}}` 后，Studio 变量面板出现「📄 批量运行（CSV）」：

1. 选 CSV 文件或粘贴文本 → 本地预览前 5 行（BOM/引号/分隔符自动识别）；
2. 给每个变量选对应列（同名自动匹配，缺列红字拦截）；
3. 选项：显示浏览器窗口、某行失败后继续、行间隔 ms；
4. 开始 → 进度条 + 实时行列表（失败原因/步骤/截图）+ 可停止（当前行跑完再停）；
5. 结束 → 结果汇总 + 「导出结果 CSV」（原列 + 状态 + 失败步骤 + 失败原因 + 耗时，UTF-8 BOM，Excel 直接打开）。

实现要点：

- `@rr/executor` 的 `playBatch`：**浏览器只启动一次**，每行新建 context（登录态也带上），行级 artifacts 落 `artifacts/<flowId>/batches/<batchId>/row-N/`；
- 行内缺变量只算**该行失败**，整批继续；`VARIABLE_MISSING` 带变量名；
- 限制：CSV 默认 ≤2000 行 / 5MB；不支持 xlsx（请另存 CSV）；并发固定 1（业务系统避免压测/幂等风险）；批次只存内存。

## 登录态持久化 + 单步重录（Sprint 1）

**登录态**：录制时登录一次，之后录制/回放自动带上（Playwright storageState，按 origin 存 `profiles/`，含 cookie + localStorage）。

- Studio 流程头部显示「已保存/未保存登录态」；「更新登录态」打开浏览器让用户重新登录，点「完成并保存」写入；「清除登录态」删除。
- 回放失败且当前 URL 命中 `/login|signin|auth|sso|登录/` 时，错误信息追加「登录状态可能已过期，请在 Studio 里点『更新登录态』…」。
- 已知限制：Playwright `storageState` 不含 sessionStorage（SSO 若把 token 放 sessionStorage 仍会丢）；不做登录态预检。

**单步重录**：某一步失效时只重录这一步，不用整条重来。

- 时间线每步「重录」→ 浏览器打开起始页（自动带登录态）→ 用户手动走到目标位置并操作 → 停止 → 从本次录到的动作里选一个 → 替换第 N 步（保留原 stepId，`version+1`，写 `.bak`）。
- 这是"方案 A"：不自动回放前缀，避免重复提交等副作用；代价是候选里含导航过程的动作，由用户选择。

契约：`docs/profiles-rerecord.md`；端到端 3/3（本地 `e2e/`）；Studio API 测试：`packages/studio/src/profiles.api.test.ts`（15 条）。

## 参数化建议（Phase 1：规则召回 + 一键采纳）

录完流程后，Studio 自动提示"这个值每次都变，要不要变成运行参数？"

```bash
npx tsx packages/cli/src/main.ts suggest flows/local-basic.json   # CLI 只读查看建议
```

- **规则召回**（`@rr/suggest`，117 单测）：输入类型/值格式/中英文字段词表/同值重复打分；搜索框、泛化 textarea 负向降权；password/多选/空值直接排除并给中文原因；置信度 high/medium/weak（默认只展示 high+medium）
- **Studio 交互**：步骤行 `💡 建议参数化` + 接受/修改/忽略；底部批量条「全部接受」；接受弹窗可改变量名/类型、勾选"同值一起替换"；变量区支持重命名；忽略记在 localStorage（不写 IR）
- **IR 变更**：接受后 `value` 变 `{{变量}}` + `variables[]` 增加定义，`version+1` 且写 `.bak`
- **CLI/端到端**：`rr suggest` 只读；本地端到端覆盖"录制→建议→接受→回放（带变量通过/缺变量 VARIABLE_MISSING）"

> Phase 2（AI 裁决）接口已预留：`@rr/suggest` 的 `SuggestionAdjudicator`，只对 medium/weak 候选调用，
> 输入只包含字段语义 + **脱敏后的值格式**（不传原文/DOM/截图），等内网模型端点到位再接。

## v0.2 新增录放能力（多标签页 / 对话框 / 下载 / 组合键 / 上传）

| 能力       | 说明                                                                                      | 验收 flow                          |
| ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| 多标签页   | `window.open` 新页自动编号（0=起点页），自动合成 `switchTab`；回放时切页 + `bringToFront` | `flows/smoke-tabs.json`（7 步）    |
| hover 菜单 | 鼠标停留 350ms 上报，只保留"有语义"的 hover（aria-haspopup 或随后点了别的元素）           | `flows/smoke-hover.json`（2 步）   |
| 原生对话框 | 录制自动 accept 并插 `dialog` 步骤；回放 manual 模式消费 pending dialog                   | `flows/smoke-dialog.json`（4 步）  |
| 下载       | 触发下载的步骤自动补 `expect:download`，文件落到 `artifacts/.../downloads/`               | `flows/smoke-upload-download.json` |
| 上传       | file input 点击记 `upload` + `{{file_N}}` 变量（回放传真实路径）                          | 同上                               |
| 组合键     | 非 Shift 修饰键 → `key{modifiers}`（Ctrl/Cmd+A/C/V…）                                     | `flows/smoke-combo.json`（2 步）   |

> 已知限制：文件路径浏览器不暴露（上传只能占位变量）；prompt 框只能记默认值；macOS 的 `Control+A` 不是全选（录制端忠实记录按键）；closed shadow 内的输入框仍只能点不能填。

## Studio（本地 Web 控制台，给业务人员用）

```bash
pnpm studio          # http://127.0.0.1:4400
```

- 顶部填网址 → 开始录制（打开受控 Chromium，用户正常操作）→ 停止并保存
- 停止后自动**自检**（回放一次），失败步骤标红并给人话原因
- 左侧流程列表、右侧步骤时间线（截图/命中级别/耗时），支持重命名、删除步骤
- 回放面板：填变量（secret 用密码框）→ 回放 → 每步状态 + 失败原因
- 契约：[docs/studio-api.md](docs/studio-api.md)

## 公网复杂站点语料库（10 站）

见 [docs/public-corpus.md](docs/public-corpus.md)：**6/10 站点全绿、20/30 runs 通过（66.7%）**，51 步链路覆盖电商/企业后台/表单/动态列表/搜索/组件库/文档站。

```bash
npx tsx scripts/public-corpus.ts run --runs 3
```

## 下一步（M2）

1. 补齐 11 条本地 flow（canvas 用 `click.position`、upload 用 `setInputFiles`、dialog 用 dialog 策略）
2. 20 条 flow × 10 runs，目标 ≥85%；失败分类统计与归因
3. 加 L2 增强（属性交集）与 expect（textChange/区域 hash）——按数据决定
4. `stableHash` 上移到 `@rr/schema`，去掉跨包复刻

## 本地测试脚手架（未纳入仓库）

为了让仓库只保留产品代码，以下两个目录**不提交**（`.gitignore`）：

| 目录        | 内容                                                                  | 怎么跑                                  |
| ----------- | --------------------------------------------------------------------- | --------------------------------------- |
| `fixtures/` | 自建测试站（18 个难场景路由 + 双端口跨域 + 登录/上传下载页）          | `pnpm site`（:5173），或由 e2e 自动拉起 |
| `e2e/`      | 端到端测试：录制→回放、新能力、登录态、参数化、CSV 批量（5 套 14 条） | `pnpm e2e`                              |

> 新克隆仓库后这两个目录不存在，`pnpm e2e` / `pnpm site` 会失败——这是预期：
> 产品本身不依赖它们（`pnpm test`、`pnpm typecheck`、`pnpm studio` 均可独立运行）。
