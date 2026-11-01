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
- [../产品设计-录制回放-v0.1.md](../产品设计-录制回放-v0.1.md) —— 产品设计
- [../refs/README.md](../refs/README.md) —— 14 个参考仓库索引

## 状态

| 模块 | 状态 |
|---|---|
| IR（schema + 契约 + 18 单测） | ✅ M0 |
| fixture 测试站 | 🚧 M0 |
| Spike A/B | 🚧 M0 |
| recorder / resolver / executor / ai / harness | ⏳ M1 |
| CLI | 骨架可用（inspect 已实现） |
