# alibaba/page-agent 借鉴价值评估

> 评估对象：https://github.com/alibaba/page-agent（v1.12.4，commit `9eb6b66`，MIT）
> 评估时间：2026-11-01 ｜ 方式：浅克隆源码逐文件精读（core / llms / page-controller / ui / extension / mcp 六个包），未跑构建
> 工作副本：`/tmp/page-agent`（可用 `git clone --depth 1 https://github.com/alibaba/page-agent.git` 重建）

---

## 0. TL;DR

**值得看，但值得抄的大概只有 20%。**

| 结论 | 内容 |
|---|---|
| **最值得抄（骨架级）** | ① DOM → token 的"脱水"文本协议；② index → DOM ref 的内存映射 + 可交互启发式；③ 单 MacroTool + `tool_choice` 强制 + 反思三字段；④ 每步无状态重建 prompt（而不是累积 messages） |
| **值得改造后抄** | 合成事件栈（点击/输入补偿）、错误归一化中间件、history/activity 双流、遮罩+假光标、工程化实践（AGENTS.md / live test / agentic 回归清单） |
| **不要抄** | 跨标签页扩展层的实现方式、上下文管理（它根本没有）、重试机制（原样重发、会重复副作用）、MCP 实现（缺超时/鉴权/版本协商） |
| **一句话** | 这不是一个"通用 Agent 框架"，而是**一个把「网页 → 一页 token → 一次动作」压缩到极致的工程范本**。它的价值 80% 在 page-controller 的 DOM 脱水协议和 core 的三个结构性选择上，其余是围绕这两个点的补丁与适配。 |

---

## 1. 它到底是什么

**定位**：In-page GUI Agent —— 一行 `<script>` 注入到自己的网页里，页面就自带一个能用自然语言的 AI 操作员。不依赖浏览器扩展、不依赖 headless 浏览器、不截图、不用多模态模型，纯靠 DOM 文本理解页面。

**架构**（npm workspaces，source-first，开发期 `exports` 直指 `src/*.ts`）：

```
packages/
├── page-agent/        # 入口类（带 UI Panel），npm: page-agent
├── core/              # PageAgentCore：主循环 / tools / prompt / autoFixer（无 UI）
├── llms/              # OpenAI 兼容客户端 + 错误分类 + 模型补丁（不依赖 core）
├── page-controller/   # DOM 提取 / 动作 / 遮罩（不依赖 LLM）
├── ui/                # Panel + i18n，通过 PanelAgentAdapter 接口与 agent 解耦
├── extension/         # 可选浏览器扩展（WXT + React），多标签页
├── mcp/               # 可选 MCP server（~330 行）
└── website/           # 文档站
```

**体量**：TS/TSX 约 2 万行；核心引擎 `page-controller/src/dom/dom_tree/index.js` 1745 行，是 **browser-use 0.5.9 的移植**（文件头写了 `@match` 与 14 条差异注释）。

**能力边界**（官方文档原文归纳，很重要）：

| 支持 | 不支持 |
|---|---|
| 点击、文本输入、下拉选择、滚动（垂直/水平） | 悬停、拖拽、右键菜单、键盘快捷键、坐标定位 |
| 同源 iframe（仅单层） | 嵌套 iframe、跨域 iframe |
| 执行 JS（默认关闭，需显式开启） | Canvas / WebGL / SVG / 图片语义（无视觉能力） |
| SPA 单页 | Monaco / CodeMirror 等需要 JS 实例的编辑器 |

---

## 2. 值得借鉴的点（按价值排序）

### 2.1 ★★★★★ DOM → token 的"脱水"协议

**解决的问题**：文本模型要在不给截图的前提下"看懂"页面，还能被精确操作；同时把 token 压到可接受范围。

**做法**：递归遍历 DOM 生成扁平树，每个**可交互**元素分配一个自增 `index`，序列化成缩进文本。真实输出长这样（用仓库真实序列化器跑出来的）：

```text
Current Page: [登录 - 示例站](https://example.com/login)
Page info: 1440x900px viewport, 1440x1800px total page size, 0.0 pages above, 1.0 pages below, 2.0 total pages, at 0% of page

Interactive elements from top layer of the current page (full page):

[Start of page]
登录到示例站
[0]<a >返回首页 />
[1]<label for=username>用户名 />
	[2]<input type=text name=username placeholder=请输入用户名 />
[3]<label for=password>密码 />
	[4]<input type=password placeholder=请输入密码 />
[5]<button type=submit>登录 />
[8]<a target=_blank>立即注册 />
[End of page]
```

**信息密度技巧（这是精华）**：

1. **`[index]` 完全替代 selector / xpath / href** —— "可操作对象"被压成一个整数，模型只需回传数字；
2. **交互元素的子树文本折叠进元素行**，用自闭合 `/>` 表示"此节点不展开子树"，省掉大量 `</div>`；
3. **属性白名单**（约 20 个：`type/name/role/value/placeholder/aria-*/data-state/...`），且做三重去重：值 >5 字符的重复属性只留第一个、`role==tagName` 删除、`aria-label/placeholder/title` 与元素文本相同则删除；单值截断 20 字符；
4. **`*[n]` 标记本轮新出现的元素**（相对上一步），让模型知道"新弹出来的按钮"；
5. **`data-scrollable="bottom=840, right=0"`** 内联滚动容器四向剩余距离，让模型知道"哪块能滚、还能滚多远"；
6. **header/footer 用自然语言**给 URL、视口/页面尺寸、"上方/下方还有几页"；
7. **整棵剪枝**：`script/style/svg/link/meta`、`aria-hidden=true`、以及带 `data-browser-use-ignore` / `data-page-agent-ignore` 的节点。

**怎么用**：一个 `.ts` 文件 + 一个序列化函数即可移植（MIT）；任何"文本模型 + 网页"的场景（Copilot、RPA、自动化测试的自然语言层）都直接受益。
**成本/风险**：低。坑：本仓库的 system prompt 示例写的格式（`[33]<div>User form</div>`、带引号闭合标签）与真实输出（`<div >User form />`、无引号、自闭合）**不一致**，照抄时建议直接用真实格式写 prompt；另外"缩进"表示的其实是"被高亮的祖先链"，不是真实 DOM 层级。

---

### 2.2 ★★★★★ index → DOM ref 的内存映射 + 可交互启发式

**做法**：

- 提取时同时产出 `selectorMap: Map<number, HTMLElement>`，动作执行时 `getElementByIndex(index)` **直接拿到元素引用**，不做 `querySelector`、不生成 xpath（作者明确注释 "no need for xpath"）。
- 判定"可交互"不依赖事件监听探测（页面上下文拿不到 `getEventListeners`），而是一套组合启发式，按代价从低到高短路：

```
黑名单 → 白名单 → computed cursor ∈ {pointer, move, text, grab, ...30+种}（作者自称
"Genius fix for almost all interactive elements"）→ 标签白名单(a/button/input/select/
label...) → 排除 disabled/readonly/inert → contenteditable → class 含 button/dropdown-toggle
→ ARIA role 集合(button/menuitem/checkbox/tab/switch/combobox...) → onclick 属性
→ 可滚动元素（可滚即交互）
```

- 再加一层"是否被遮挡"判定 `isTopElement`：中心点 + 左上 + 右下三个采样点做 `elementFromPoint`，命中后回溯 `parentElement` 看是否包含自己 → 只有可见且未被遮挡的元素才给 index。

**索引的稳定性真相（必须知道）**：

- index 是**每次 `updateTree()` 从头从 0 重排**的"本轮遍历到的第 n 个可交互元素"，**不是元素身份**；只在单次快照内有效。
- 流程靠"每步开头重新观测 + 每步只执行一个动作"来规避跨步引用旧 index，但**没有任何机制阻止模型记旧 index，也没有元素身份校验**。
- 更关键：动作链路里**没有 `isConnected` 校验**。React/Vue 重渲染把节点替换掉后，旧 ref 变成 detached，`getBoundingClientRect()` 全 0 → 点击落在 (0,0) → 合成事件无效 → **工具依然返回 `✅ Clicked`**（静默空操作的主要来源）。作者自己在注释里承认不如 browser-use 的 `hash(位置, 属性)` 方案。

**怎么用**：借"index → ref"这个思路，但**加两道保险**：① 动作前 `element.isConnected` 校验；② 元素身份用 `hash(位置+属性)` 或 `data-*` 自增 id，动作后校验命中目标。
**成本/风险**：低-中（启发式约 300 行纯函数）。

---

### 2.3 ★★★★★ 单 MacroTool + `tool_choice` 强制 + 反思三字段

**做法**：把所有工具（9 个内置 + 3 个 tab 工具 + 自定义）压成**一个** `AgentOutput` 工具，参数是"反思三字段 + 单 action union"：

```ts
// core/src/PageAgentCore.ts:389-405
const actionSchemas = Array.from(tools.entries()).map(([toolName, tool]) =>
  z.object({ [toolName]: tool.inputSchema }).describe(tool.description))
const actionSchema = z.union(actionSchemas as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
const macroToolSchema = z.object({
  evaluation_previous_goal: z.string().optional(),
  memory: z.string().optional(),
  next_goal: z.string().optional(),
  action: actionSchema,
})
```

请求侧再强制：`tool_choice = {type:'function', function:{name:'AgentOutput'}}` + `parallel_tool_calls: false`。

**为什么好**：

- 每个 step **恰好一次调用、一个动作**，反思与动作原子绑定 → 决策可回放、可校验、可审计；
- 请求里 tools 数组**恒为 1**，天然躲开各家 provider 对工具数量/描述长度的差异；
- `action` 是"单键对象 union"，模型结构上无法一次做多件事。

**怎么用**：任何"让模型返回结构化动作"的场景（不只浏览器）。成本约 50 行。
**风险**：union 生成的 `anyOf` schema 对严格 JSON Schema 的供应商不友好，需要兼容层兜底；工具一多 prompt 变长。

---

### 2.4 ★★★★☆ 每步无状态重建 prompt，而不是累积 messages

这是全仓库**最反直觉**的设计：每步只有两条消息（system + user），**从不用 assistant/tool 多轮消息**。

```ts
// core/src/PageAgentCore.ts:273-288
const messages = [
  { role: 'system', content: this.#getSystemPrompt() },
  { role: 'user', content: await this.#assembleUserPrompt() },
]
const result = await this.#llm.invoke(messages, { AgentOutput: this.#packMacroTool() }, signal, {
  toolChoiceName: 'AgentOutput',
  normalizeResponse: (res) => normalizeResponse(res, this.tools),
})
```

user prompt 用四段 XML 拼装：`<instructions>` → `<agent_state>`（用户请求 + 步数）→ `<agent_history>` → `<browser_state>`；历史只文本化"反思三行 + 动作结果"：

```ts
prompt += `<step_${n}>\n`
prompt += `Evaluation of Previous Step: ${event.reflection.evaluation_previous_goal}\n`
prompt += `Memory: ${event.reflection.memory}\n`
prompt += `Next Goal: ${event.reflection.next_goal}\n`
prompt += `Action Results: ${event.action.output}\n`
prompt += `</step_${n}>\n`
```

**收益**：① 绕开 OpenAI tool-message 配对协议（`tool_call_id` 缺失/顺序错/并行调用等一整类兼容 bug 全部不存在）；② prompt 前缀单调增长，**天然吃满 prefix cache**（所以它专门统计 `cachedTokens`）；③ 换模型成本极低。
**代价**：每步重发全量历史（token 随步数线性涨）；且**它没有任何裁剪/预算逻辑**，防爆全靠 `maxSteps=40`（所以别学这点，见 §3）；另外 `step_info` 里塞了 `new Date()`，位置又在 history 之前，每步前缀都变，反而破坏了缓存。

---

### 2.5 ★★★★☆ 输出归一化中间件（autoFixer）

**问题**：真实模型不按规范输出——不 call tool、把 action 名当工具名、JSON 塞在 content 里、参数双重 stringify、只给 action 层。

**做法**：在 LLM 客户端"校验完 finish_reason、查找 tool 之前"挂一个 `normalizeResponse` 钩子，把各种脏输出改写成标准 tool_call，5 类修复打补丁：

```
#1 模型把 action 名当工具名 → 包一层 {action: ...}
#2/#3 JSON 落在 message.content 里 → 正则抽 { ... }，再拆双层包装
#4 action 缺失且无反思字段 → 判定为 action 层，包一层
#5 彻底没有 action → 兜底 {action:{wait:{seconds:1}}}   ← 会静默空转，慎用
```

外加：参数按工具 Zod schema 二次校验、基元参数强转（`{"click_element_by_index": 2}` → `{"index": 2}`）、未知动作报"可用工具清单"、`z.prettifyError` 人类可读报错。
**关键点**：**修复逻辑不放在传输层，而是作为钩子由调用方提供**——客户端保持"哑"，脏活按业务写。

---

### 2.6 ★★★★ 错误分层：预期内失败回文本，意外异常走错误码

两条完全不同的路径，这是 Agent 鲁棒性的核心：

| 路径 | 触发 | 处理 |
|---|---|---|
| **A：预期内失败** | 元素 index 不存在、点击无效果、下拉找不到选项 | controller 内部 `try/catch` **不抛**，返回 `{success:false, message:'❌ Failed ...'}`；tool 只把 `message` 返回 → 进入下一步 `<agent_history>` 的 `Action Results:` → **模型自己看、自己纠** |
| **B：意外异常** | 工具实现 bug、网络错误 | 抛错 → 包成 `InvokeError(retryable)` → 客户端重试；耗尽后任务失败 |

**错误分类表**（值得直接抄）：网络 / 限流 / 5xx / 无 tool call / 参数不合法 / 工具执行异常 → **可重试**；配置错 / 鉴权 / 上下文超长 / 内容审核 → **不重试**；`AbortError` **永远穿透**（4 处 catch 都显式判断，并有专门单测）。
**它做错的地方**：只回 message 丢了 `success` 布尔 → 框架无法程序化判断"这步失败了"，只能让模型读 emoji；且工具执行嵌在 LLM 客户端内部，重试会**重复执行点击**（见 §3）。

---

### 2.7 ★★★★ 合成事件栈：点击 / 输入 / 滚动的工程细节

纯页面内方案没有 CDP，只能自己合成，这部分踩坑经验值钱：

**点击**（不是 `element.click()`）：

```
pointerout/pointerleave/mouseout/mouseleave + blur（清上一次 hover 状态）
→ scrollIntoViewIfNeeded（含 iframe 祖先）
→ 通过事件总线移动"假光标"（0.3s）
→ 临时把遮罩设为 pointer-events:none，用 elementFromPoint 取最深命中元素作为 target
→ pointerover → pointerenter(不冒泡) → mouseover → mouseenter
→ pointerdown → mousedown → focus({preventScroll:true}) → pointerup → mouseup → target.click()
→ wait 0.2s
```

**输入**：先点击聚焦；普通 input/textarea 用**原型链 native value setter** 绕过 React 的 value tracker，再 `dispatchEvent(new Event('input', {bubbles:true}))`（8 行 utils，直接可抄）；contenteditable 走 `beforeinput` + 校验 + 回退 `execCommand`。

**滚动**：从目标元素向上找最多 10 层 `overflow:auto|scroll` 且 `scrollHeight > clientHeight` 的容器，定向滚动。

**已知缺口**（照抄要补）：没有键盘事件（**无法"输入后回车"**、IME 中文输入不可用）、无 hover / drag / upload、合成事件 `isTrusted=false`、PointerEvent 缺 `isPrimary/composed`；`selectOption` 只支持原生 `<select>`，antd / Element Plus / Radix 的"假下拉"全靠点击启发式，`patches/antd.ts` 是**未实现的空壳死代码**。

---

### 2.8 ★★★ 视觉反馈层：遮罩 + 假光标 + CustomEvent 总线

- 全屏遮罩 `position:fixed; z-index:2147483641; cursor:wait`，拦截 click/mousedown/mousemove/wheel，**并给自己打上 `data-page-agent-ignore`**（让提取器剪掉它，避免"agent 点自己的面板"）；
- 假光标是三层 SVG（渐变描边 / 填充 / 点击波纹），rAF + lerp 0.2 跟随；
- **动作层与视觉层完全解耦**：通过 `window` 上的 CustomEvent 通信 —— `PageAgent::MovePointerTo` / `ClickPointer` / `EnablePassThrough` / `DisablePassThrough`；actions 不 import mask，mask 不 import actions；
- 暗色检测 181 行启发式（class / data-attr / color-scheme / 背景亮度 / 文字亮度 / 主容器亮度六级短路），值得直接抄。

**怎么用**：任何"让用户看得见 AI 在操作"的产品都需要这层信任感；`enablePassThrough` 这个设计（命中测试时临时放行）尤其聪明。
**坑**：键盘/触摸拦不住（`keydown` 只在焦点位于遮罩内触发，而遮罩不可聚焦）；rAF 构造即启动需手动 dispose。

---

### 2.9 ★★★ 多标签页：pull 而非 push

MV3 service worker 随时会被杀，作者的铁律写在文件头：

> "Keep this stateless: pure request/response handlers only, no in-memory state, no ports, no event pushing. MV3 SW should be killed and restarted at any time."

于是：每个 step 前**主动拉取**全部 tab 状态（而非长连接推送），tab 摘要生成一张 Markdown 表格塞进 `browser_state.header`：

```
| Tab ID | URL | Title | Status | Current |
```

**借的是思路，不是代码**：`RemotePageController` 用 `as any` 硬塞进 `pageController` 接口、返回类型自造、真正的 `ActionResult` 甚至没 export → 加一个 DOM 方法要人肉同步 3 处且编译期无感；`AbortSignal` 无法跨上下文导致 `execute_javascript` 直接被砍掉、点击后固定 `sleep(1000)`、每个 tab 每 500ms 做 3 次独立 `storage.get`。**跨上下文代理一旦做，所有同步/可中断原语都要重写**，这是本质代价。

---

### 2.10 ★★★★ 可观测性与解耦：三个细节

1. **history / activity 双流分离**：`history`（持久、进 LLM 上下文、UI 渲染、可导出）+ `activity`（瞬时：thinking/executing/retrying，只给 UI、**不进 prompt**）。避免"瞬时状态污染持久记忆"。
2. **`PanelAgentAdapter` 81 行极小接口**（`status` / `history` / `lastResult` / `execute` / `stop` / `dispose` + 三事件），UI 只依赖它，不 import core。仓库里 DOM 版 Panel 和 React 版 sidepanel **共用同一契约**，就是这套解耦的证明。
3. **全量 raw request/response 存档 + UI 可展开**：每步都能在面板里展开 Raw Request / Raw Response，甚至从 rawRequest 里把 system/user prompt 原文抽出来看。`AGENTS.md` 里写着一句话：*"Traceability and predictability is more important than success rate."* —— 对 Agent 类产品，可调试性就是第一生产力。

---

### 2.11 ★★★★ 工程实践（这一块比代码更值得学）

| 实践 | 具体做法 |
|---|---|
| **AGENTS.md 驱动** | 根目录 + 子包各一份 `AGENTS.md`，写清模块边界、命令、关键文件表、加功能的步骤、测试规范；`CONTRIBUTING.md` 明确"核心库和扩展禁止 vibe coding，网站/UI/测试鼓励 AI 生成" |
| **仓库内技能库** | `.agents/skills/` 下 5 个 `SKILL.md`：`maintain-model-list`（加模型时三处同步的完整 SOP）、`submit-pr-from-current-changes`（含"AI 不许勾选人工声明项"的硬规则）、`pre-impl-discussion`、`update-changelog`、`git-cleanup` |
| **Agent 化回归清单** | `docs/agentic-testing/actions.md`：11 个真实站点用例表（Bing / AntD Select / Element Plus Menu/DatePicker / Quill / MUI / Radix...），写明"用 computer use 执行、用 vision 校验"，每条附对应 PR/Issue 编号 |
| **live test 约定** | `*.live.test.ts` 打真实 API、不进 CI、key 缺失自动 skip、`npm run test:live` 单独跑；只测"请求/响应形状是否兼容"（强制 echo 工具），不是能力评测 |
| **source-first monorepo** | 开发期 `exports` 指向 `src/*.ts`，发布时 `pre-publish.js` 把 `publishConfig` 提到顶层切到 `dist/`，`post-publish.js` 还原 |
| **并行 CI** | `scripts/ci.js`：commitlint（main 跳过）→ lint/format/typecheck/test 并行 → build；`--no-build` 可跳过 |

---

### 2.12 ★★★ 安全与合规钩子（做生产必须补的部分）

- `transformPageContent(content)` 钩子：**在 DOM 脱水后、发给 LLM 前**统一处理，官方示例就是手机号/邮箱/身份证/银行卡正则脱敏 —— 合规成本最低的做法；
- 元素操作**黑白名单**：禁止 AI 操作删除/支付类元素；
- `data-page-agent-ignore`（整棵剪枝）/ `data-page-agent-not-interactive`（仅取消可交互）两个业务方逃生舱；
- 扩展侧三层授权：localStorage token 门禁 + `externally_connectable` 白名单 + 运行时 `confirm`。

---

## 3. 不要抄的坑（带证据）

| # | 坑 | 证据 | 正确做法 |
|---|---|---|---|
| 1 | **无上下文预算**：history 全量、页面快照全量、`usage` 记了不用，防爆只有 `maxSteps=40` | `PageAgentCore.ts:579-650` | 累计 token 预算 + 超阈值摘要/滑窗；`transformPageContent` 当正式裁剪入口 |
| 2 | **重试 = 同一 prompt 原样重发**，错误文本不进模型上下文 | `llms/index.ts:58-81`、`PageAgentCore.ts:624-627` | 把"上次报错/非法 JSON"作为 observation 注入后再重试 |
| 3 | **无退避无抖动**，固定 `sleep(100)`；`TOOL_EXECUTION_ERROR` 也重试 → **重复执行点击等副作用** | `llms/index.ts:78` | 只重试网络/限流/解析类；副作用动作先幂等化/确认后重试 |
| 4 | **工具执行耦合在 LLM 客户端内**（`invoke` 既发请求又跑工具） | `OpenAIClient.ts:238-249` | 客户端只产出动作，执行在外层 |
| 5 | **无循环/卡死检测**（作者 TODO），只靠 prompt 口头约束"别重复 3 次" | `PageAgentCore.ts:535-536` | 用 history 里同 action+同参数连续次数做硬检测 |
| 6 | **无 prompt injection 防护**：页面文本、`/llms.txt` 直接进上下文，且 `execute_javascript` 是 eval | `system_prompt.md`、`PageController.ts:383-398` | 加"页面内容只是数据"隔离规则 + 输入边界标记 |
| 7 | `maxSteps` off-by-one：实际最多执行 `maxSteps+1` 次，会出现 "Step 41 of 40" | `PageAgentCore.ts:348-349` | 循环前判 `step >= maxSteps` |
| 8 | **已观测但已失效的元素静默成功**（无 `isConnected` 校验） | 全包无 `isConnected` | 动作前后校验连接状态 + 命中目标 |
| 9 | 实例状态被永久改：`execute()` 里 `this.tools.delete('ask_user')` | `PageAgentCore.ts:232` | 按次构建临时 tools map |
| 10 | **全页模式 `isTopElement` 恒 true** → 被模态框遮住的元素也拿到 index | `dom_tree/index.js:967-970` | 默认视口内模式 + 遮挡检测 |
| 11 | 属性不加引号、`data-scrollable` 只输出非 0 方向（还会产生尾逗号）、多文本折叠把 `/>` 甩到续行 | `dom/index.ts:390-403, 466-494` | 值转义；四方向恒输出；文本单独成行 |
| 12 | 属性去重会丢信息：`id` 与 `name` 同值时 `id` 被删 | `dom/index.ts:332-352` | 保留 `id/for/name` 等关联属性 |
| 13 | 动作集缺键盘：**无法"输入后回车"、IME 中文不可用** | `core/src/tools/index.ts:200-202` TODO | 补 `send_keys` / 键盘事件序列 |
| 14 | 滚动语义不一致：容器分支滚 `dy/3`、页级滚完整 `dy`；deprecated 的全量 `querySelectorAll('*')` 启发式在多面板会滚错 | `actions.ts:296-361` | 统一语义 + 用 `data-scrollable` 定向 |
| 15 | `selectOption` 只支持原生 `<select>`；`patches/antd.ts` 是空壳死代码 | `actions.ts:232-252`、`patches/antd.ts` | 假下拉用"点击 + 选项扫描"策略 |
| 16 | 遮罩拦不住键盘/触摸（`keydown` 绑定在不可聚焦的 wrapper 上） | `SimulatorMask.ts:44-71` | 绑 `document` + `{capture:true}`，补 pointer/touch/contextmenu |
| 17 | 全量高亮 overlay：每个可交互元素 2-3 个 div + 2 个全局监听，每轮重建 | `dom_tree/index.js:167-414` | 生产只高亮当前目标 |
| 18 | 扩展层契约漂移：`as any`、返回类型重复定义、`sendMessage` 失败吞成 `null` 后又被当对象用 | `MultiPageAgent.ts:58`、`TabsController.ts:75-76` | 方法表提成导出的 interface，代理侧 `implements` |
| 19 | `modelPatch` 是 255 行"模型名 if-else"，覆盖不到私有化部署；且与文档、live test 形成三处手工同步 | `llms/utils.ts:41-211` | 收成配置表 + 单一真源 |
| 20 | 文档漂移：`AGENTS.md` 提到的 `AgentBrain` / `getSimplifiedHTML()` 根本不存在；文档写 `maxRetries` 默认 3，代码是 2 | `AGENTS.md:66-103` | 文档与类型同源生成 |
| 21 | MCP 层：无 Origin 校验、无超时（工具调用可永久悬挂）、单客户端、`// TODO: Add version checking` | `mcp/src/hub-bridge.js` | 抄"通用 hub 协议"的分层，自己补超时/鉴权/版本协商 |
| 22 | 测试覆盖很薄：DOM 提取/索引/序列化/动作全无单测（`PageController.test.ts` 仅 40 行），只靠人工回归清单 | 同上 | 序列化器是最该单测的纯函数 |
| 23 | `extension/package.json` 声明了 `@page-agent/ui` 但从未使用（死依赖）；生产包里硬编码了 demo 测试端点 | `extension/package.json:46`、`constants.ts:5-13` | 清依赖；端点走配置 |

---

## 4. 怎么用到我们自己的项目（三种场景）

### 场景 A：给自己的产品加 AI Copilot（SaaS 后台 / ERP / 表单）

**直接复制 60% 的 page-controller**，不需要扩展和多页：

1. 移植 `dom_tree` + 序列化器（2.1），把 prompt 示例改成真实格式；
2. 用 MacroTool 方案接自家模型（2.3），保留反思三字段；
3. 动作层先实现 **click / input(native setter) / scroll** 三个就够覆盖 80% 场景（2.7）；
4. 补 `transformPageContent` 脱敏 + 元素黑白名单（2.12）——上线合规必需；
5. 补 `isConnected` 校验 + 动作后状态回读（§3-8），否则会遇到"提示成功但没生效"的诡异 bug。

**工作量大头**：不在核心，而在"每个业务系统的可交互判定调优"（建议直接暴露 `data-page-agent-ignore` 让业务方标注）。

### 场景 B：做自动化测试 / RPA 的自然语言层

**只借 2.1 + 2.7 + 2.11**。定位是"Playwright 之上的自然语言选择器"：

- 用它的脱水文本给 LLM 选元素，实际执行仍走 Playwright 的 `locator`（拿到 `isTrusted` 的真实事件，绕开合成事件的所有缺陷）；
- 索引→元素的映射改成"索引 → 稳定 selector（`data-testid` 优先）"；
- 用 `docs/agentic-testing/actions.md` 那份 11 条真实组件用例表当你自己的回归清单起点（这是最被低估的资产）。

### 场景 C：做自研 Agent 框架（不碰浏览器）

**借 2.3 / 2.4 / 2.5 / 2.6 / 2.10**，这五个是模型无关的：

1. 单 MacroTool + 强制 tool_choice（结构可控）；
2. 每步无状态重建 XML prompt（绕开 tool-message 协议问题）——但**要加 token 预算**；
3. `normalizeResponse` 钩子式输出修复（脏活留给业务）；
4. 错误分层 + retryable 分类 + AbortError 穿透；
5. history / activity 双流 + 极小的 UI 适配接口。

---

## 5. 附：关键文件索引

| 主题 | 文件 | 行号 |
|---|---|---|
| 主循环 / 生命周期 | `packages/core/src/PageAgentCore.ts` | 31-60（注释）、212-370（execute）、579-650（prompt 组装） |
| MacroTool 打包 | `packages/core/src/PageAgentCore.ts` | 386-468 |
| 工具定义（9 个） | `packages/core/src/tools/index.ts` | 38-202 |
| 输出归一化 | `packages/core/src/utils/autoFixer.ts` | 21-171 |
| system prompt | `packages/core/src/prompts/system_prompt.md` | 全文 152 行 |
| 类型契约 | `packages/core/src/types.ts` | 163-285 |
| LLM 客户端 | `packages/llms/src/OpenAIClient.ts` | 42-267 |
| 错误分类 | `packages/llms/src/errors.ts` | 5-56 |
| 模型补丁 | `packages/llms/src/utils.ts` | 41-243 |
| DOM 提取引擎 | `packages/page-controller/src/dom/dom_tree/index.js` | 1745 行（移植 browser-use 0.5.9） |
| 可交互判定 | 同上 | 699-958（isInteractiveElement）、966-1067（isTopElement） |
| 索引分配 | 同上 | 1420-1462（handleHighlighting） |
| 序列化 / 脱水 | `packages/page-controller/src/dom/index.ts` | 315-526 |
| 动作实现 | `packages/page-controller/src/actions.ts` | 64-126（click）、131-230（input）、236-252（select）、273-552（scroll） |
| 遮罩 / 光标 | `packages/page-controller/src/mask/SimulatorMask.ts` | 全文 216 行 |
| 暗色检测 | `packages/page-controller/src/mask/checkDarkMode.ts` | 全文 181 行 |
| UI 解耦契约 | `packages/ui/src/panel/types.ts` | 24-81 |
| 多页扩展 | `packages/extension/src/agent/` | `TabsController.ts`、`RemotePageController.ts` |
| MCP | `packages/mcp/src/` | 3 文件 ~330 行 |
| 工程实践 | `AGENTS.md`、`.agents/skills/*/SKILL.md`、`docs/agentic-testing/` | — |

**本地复现**：

```bash
git clone --depth 1 https://github.com/alibaba/page-agent.git /tmp/page-agent
# 浏览关键文件
cd /tmp/page-agent && sed -n '315,470p' packages/page-controller/src/dom/index.ts   # 脱水协议
sed -n '386,468p' packages/core/src/PageAgentCore.ts                                  # MacroTool
cat packages/core/src/prompts/system_prompt.md                                        # prompt
# 想跑起来（需自备模型 key）
echo 'LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL_NAME=...' > .env && npm i && npm start
```

---

## 6. 最终判断

| 维度 | 评价 |
|---|---|
| **架构清晰度** | ★★★★☆ 包边界干净（core 不依赖 UI、llms 不认识业务），但扩展层有契约漂移 |
| **可借鉴的原创性** | ★★★☆☆ 核心引擎移植自 browser-use，真正原创的是"脱水格式 + in-page ref + 视觉层 + 多页/ MCP 的产品化" |
| **工程质量** | ★★★☆☆ 核心库整洁且有单测，但 DOM/动作层几乎无测试、文档有漂移、多处 TODO 未收尾 |
| **直接可抄比例** | 约 20%（脱水协议、native setter、事件序列、暗色检测、错误分类、双流事件） |
| **最大启发** | "Agent 的能力上限，往往不在模型，而在于你把环境压缩成 token 的方式" —— 这份脱水协议就是最好的样例 |
