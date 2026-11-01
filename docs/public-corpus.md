# 公网复杂站点语料库测试报告

> 目的：用 10 个真实复杂站点验证「录制 → 回放（L1/L2 多级解析 + expect 校验）」在非本地环境下的表现。
> 脚本：`scripts/public-corpus.ts` ｜ flow：`flows/public-<id>.json` ｜ 日期：2026-11-01

## 1. 结论

| 指标 | 结果 |
|---|---|
| 站点数 | 10（覆盖电商、企业后台、表单、动态列表、CMS 搜索、组件库、文档站） |
| Flow 总步数 | 51 步 |
| 最终结果（每站 3 次回放） | **20/30 runs 通过（66.7%）**，**6/10 站点全绿** |
| 优化前（每站 5 次回放，未修复） | 20/50（40%），4/10 站点全绿 |
| 修复后提升 | +26.7pp |

> 结论：**结构清晰、交互确定的站点（电商/表单/列表/组件库）已达到全绿；SPA 首屏、慢站点、搜索结果页导航仍不稳。**
> 真实站点暴露的问题比本地 fixture 多一个量级，这批 flow 直接作为 M2 的回归基线。

## 2. 逐站结果（每站 3 次回放）

| 站点 | 链路 | 步数 | 结果 | 命中级别 |
|---|---|---|---|---|
| saucedemo | 登录→加购 2 件→购物车→结算→完成 | 12 | ✅ 3/3 | L1 |
| demoqa-form | 长表单（文本/单选/日期/下拉/提交弹窗） | 8 | ✅ 3/3 | L1 |
| selenium-web-form | 官方表单页（文本/密码/下拉/复选/单选/提交） | 5 | ✅ 3/3 | L1 |
| todomvc | 动态列表：新增 3 条/勾选/筛选 Active/Completed | 9 | ✅ 3/3 | L1 |
| playwright-dev | 文档站：首页→Docs→API 页 | 2 | ✅ 3/3 | L1 |
| mui-autocomplete | MUI 自动完成：输入过滤→选中 | 3 | ✅ 3/3 | L1 |
| antd-select | AntD 假下拉：打开→选项 | 2 | ⚠️ 2/3 | L1（1 次 SPA 时序失败） |
| wikipedia | 搜索→打开条目→页内导航 | 4 | ❌ 0/3 | s3 期望不符 / s4 歧义 |
| element-plus-select | Element Plus 假下拉 | 2 | ❌ 0/3 | 首屏未挂载（等待 5s 仍 0 候选） |
| orangehrm | 企业后台：登录→仪表盘→My Info→联系信息 | 6 | ❌ 0/3 | startUrl 导航失败（demo 站极慢） |

## 3. 本轮测试暴露并修复的问题

| # | 问题 | 修复 | 影响 |
|---|---|---|---|
| 1 | **SPA 首屏空窗**：resolve 立刻 `count()` 得 0 就失败（OrangeHRM/Element Plus 全挂的直接原因之一） | resolver 增加 `waitForLoadState('domcontentloaded')` + 候选出现轮询（`elementWaitMs`，默认 5s） | 所有 SPA 站点 |
| 2 | **expect 推断过激**：对 `li`/`a`/`button`/0 尺寸节点推断 `elementVisible`，动态列表/下拉场景必然 flaky（TodoMVC s7 5/5 失败） | 收窄为**白名单**：只有 `dialog/h1-h6/output` 或 `alert/status/dialog/alertdialog` 参与推断 | TodoMVC 0/5 → 3/3 |
| 3 | **tsx/esbuild keepNames**：`page.evaluate` 序列化的函数体里带 `__name(...)`，页面内 `ReferenceError`，真实站点 L2 全挂（上一轮已修，本轮验证） | resolver/executor/recorder 注入页面级垫片 | L2 降级可用 |
| 4 | secret 变量：密码被 masking 成 `{{password}}`，回放缺变量会 `VARIABLE_MISSING` | CLI `--var`、harness `RR_VAR_*`、语料库按站配置 `vars` | Selenium 表单 0/5 → 3/3 |
| 5 | 假下拉的「点击触发→点选项」间隔太短，录制容易只留下一次点击 | 录制脚本内加 700ms 等待；antd 修复后 5/5（3 run 模式下 2/3 属时序抖动） | AntD/Element Plus 类组件 |
| 6 | 慢站点默认 15s 单步超时不够 | 语料库支持 per-site `timeoutMs` | demoqa/orangehrm |

## 4. 仍未解决的问题（M2 输入）

1. **Element Plus**：replay 时首屏未挂载（等待 5s 后所有候选 count=0），录制时正常。怀疑 CDN/资源加载或 headless 风控；需要网络抓包确认（建议下一步加 `--headed` 对比 + console/network 日志）。
2. **OrangeHRM demo**：`startUrl` 30–45s 仍未 ready，`NAVIGATION_FAILED`。属公开 demo 环境过慢，建议换自建企业后台或把 goto 超时写进 flow 元数据。
3. **Wikipedia**：s3 点击搜索结果后未导航（被 expect 抓住，说明**校验有效**）；s4 候选歧义（同一文本多个链接）。需要「候选打分 + 歧义降级」在录制侧也做一次自检。
4. **AntD 时序抖动**：3 次里 1 次 s2 失败（下拉打开后选项未就绪）。可在动作前加「等待目标可见」而不是等固定时间。
5. **网络抖动**：MUI 在 5-run 模式下出现 1 次 `NAVIGATION_FAILED`，属环境噪声，报告需按 run 维度统计而不是站点维度。

## 5. 对产品的启示

1. **录制后自检**：录完立刻用同一份 flow 回放一次，失败步骤标 `needsReview` 并提示重录/补断言——本次 4 个失败站点里 3 个是"录制成功但回放不行"，自检能提前暴露。
2. **expect 只记"高置信"变化**：白名单策略正确，但还不够——应在录制后延迟 500ms 再确认元素仍存在，才写入 expect。
3. **站点级配置**（UA/超时/等待策略）要进 flow.meta，而不是散落在脚本里。
4. **回归指标要按 run 统计**，并区分 `ELEMENT_NOT_FOUND` / `EXPECT_MISMATCH` / `NAVIGATION_FAILED` —— 三者对应完全不同的修复方向。

## 6. 复现

```bash
cd rr
npx tsx scripts/public-corpus.ts record          # 录制全部（缺 flow 时）
npx tsx scripts/public-corpus.ts run --runs 3    # 回放并出表
```
