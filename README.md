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
fixtures/site/ 自建难场景测试站（iframe/shadow/canvas/虚拟列表/受控组件…）
flows/         录制产物（IR）
artifacts/     运行产物（截图/快照/日志，gitignore）
docs/          架构契约（architecture.md）、spike 结论
```

## 关键文档

- [docs/architecture.md](docs/architecture.md) —— 各包接口契约（并行开发以它为准）
- [docs/spikes.md](docs/spikes.md) —— closed shadow / iframe ref 的实测结论
- [../docs/产品设计-录制回放-v0.1.md](../docs/产品设计-录制回放-v0.1.md) —— 产品设计
- [../refs/README.md](../refs/README.md) —— 14 个参考仓库索引

## 状态（M0 + M1 已完成）

| 模块 | 状态 | 证据 |
|---|---|---|
| IR（schema + 契约） | ✅ | 20 单测（含 closed shadow/canvas 坐标契约） |
| fixture 测试站（11 难场景路由 + 双端口跨域） | ✅ | 27 条 curl + 81 条 Playwright 冒烟 |
| Spike A/B（closed shadow / iframe ref） | ✅ | `docs/spikes.md`（847 行，实测结论） |
| recorder | ✅ | capture.js + 合流 + Node 侧候选校验 + closed shadow host/offset + iframe 链；67 单测 |
| resolver（L1 + L2） | ✅ | 34 单测；L2 抹掉语义候选后 4/4 命中；歧义 15% 拒绝猜测 |
| executor | ✅ | 协议 13 种 step；失败必产 artifact；71 单测 + 14 个真实浏览器冒烟 |
| ai（默认关闭） | ✅ | 46 单测（mock fetch）；脱敏/护栏/缓存/ref 生命周期 |
| harness + CLI | ✅ | 站点清单/统计/HTML 报告；`rr harness` 6 站 18/18 通过 |
| e2e（录→放 3 次） | ✅ | `e2e/record-play.test.ts` 通过 |

### 当前基线（`pnpm rr harness --runs 3 --sites local`）

```
6/11 站有 flow · 18/18 runs 100% 通过 · 42 步全部 L1
P50 93ms / P95 354ms
```

已录 flow：`basic` / `iframe-same` / `shadow-closed` / `controlled` / `custom-select` / `spa`。
待补：`iframe-cross` / `canvas`（需要坐标） / `virtual-list` / `upload-download` / `dialog` → M2。

## 真实站点验证（SauceDemo 完整下单链路）

`flows/public-saucedemo.json`：**12 步**（登录 → 加购 2 件 → 购物车 → 结算 → 填收货信息 → 完成），密码自动转成 `{{password}}` secret 变量。

| 验证 | 结果 |
|---|---|
| `pnpm rr play flows/public-saucedemo.json --runs 10 --var password=secret_sauce` | **10/10 次通过**，12/12 步，单次 ≈1.55s |
| `RR_VAR_password=... pnpm rr harness --sites public --runs 3` | **3/3 通过**，36 步全部 L1，P50 89ms / P95 192ms |
| 破坏版（把所有语义候选替换成不存在的 css，强制降级） | **2/2 通过**，12/12 步全部由 L2 指纹接管 |

> 真实站点测试顺带抓到一个**只在 tsx 运行时才暴露的 bug**：esbuild `keepNames` 会在函数体里注入
> `__name(...)`，函数被 `page.evaluate` 序列化进页面后抛 `__name is not defined`，导致 L2 全挂。
> 已在 resolver/executor/recorder 三处注入页面级垫片修复（`NAME_KEEPALIVE_SOURCE`）。

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
