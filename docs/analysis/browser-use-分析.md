# browser-use 深度分析报告

> 评估对象：https://github.com/browser-use/browser-use（v0.13.14，MIT，Python ≥3.11）
> 分析时间：2026-11-01 ｜ 方式：浅克隆精读（`/tmp/browser-use`），约 6.9 万行 Python
> 关联：本项目 DOM 层是 [page-agent](./page-agent-借鉴点分析.md) 的直接上游 —— page-agent 的 `dom_tree/index.js` 明确标注移植自 browser-use **0.5.9**。本报告专门标出了「0.5.9 → 0.13.14 进化了什么」。
> 复现：`git clone --depth 1 https://github.com/browser-use/browser-use.git /tmp/browser-use`

---

## 0. TL;DR

| 维度 | 结论 |
|---|---|
| **它是什么** | 目前最主流的开源「浏览器 Agent」实现：CDP 直连 Chrome + 多模型 + 26 个内置动作 + 上下文压缩 + 可观测性，Python 生态里的事实标准（page-agent / 大量克隆项目都从它取材） |
| **和 page-agent 的关系** | page-agent = 它的 DOM 层（0.5.9）+ 自研的 in-page 架构；**browser-use 的 Agent 层、上下文层、浏览器会话层，page-agent 完全没有** |
| **最值得抄的 3 样** | ① 消息结构（`system + 单一可变 state + context`，历史文本化）→ 决定了上下文管理的一切；② `paint_order` 遮挡过滤（CDP paintOrders + 矩形并集几何减法）；③ `long_term_memory` / `extracted_content(only_once)` + `<read_state>` 的一次性信息通道 |
| **最不该抄的 3 样** | ① 4188 行 god object `Agent`；② 只有软提示的循环检测（不会真停）；③ compaction 默认开启且不可回溯（会不可逆丢事实） |
| **一句话** | 如果 page-agent 教的是「怎么把网页压成 token」，browser-use 教的是「**长任务怎么不被自己的上下文撑死**」—— 这两件事拼起来才是一个能跑生产的长任务 Agent。 |

---

## 1. 它是什么

**定位**：Python 的浏览器自动化 Agent 框架。直接用 CDP 连本地 Chrome（或远程/云浏览器），LLM 每一步输出一个动作，循环执行直到完成。

**架构**（`browser_use/`，约 6.9 万行）：

```
browser_use/
├── agent/                 # ★ 核心：service.py 4188 行（主循环）、message_manager/（上下文）、
│                          #   prompts.py + system_prompts/（prompt）、judge.py（事后裁判）
├── tools/                 # 动作体系：service.py 2327 行（26 个内置动作）、registry/（装饰器注册）
├── dom/                   # ★ DOM 层：service.py 1245 行（CDP 三棵树）+ serializer/（paint_order、文本化）
├── browser/               # 浏览器会话：session.py 4197 行、watchdogs/（12 个）、events.py（46 个事件）
├── llm/                   # 20+ provider 适配：base.py（Protocol 抽象）、schema.py（结构化输出优化）
├── actor/                 # 独立的低层 CDP 自动化库（page/element/mouse），可绕过 LLM 直接用
├── beta/                  # 并行的重写版 Agent（6810 行），v0.13 主线不用它
├── skills/ mcp/ sandbox/  # 云端技能、MCP、沙箱
└── screenshots/ filesystem/
```

**依赖**：`bubus`（事件总线）、`cdp-use`（CDP 客户端）、`pydantic`、`posthog`（telemetry）、各模型 SDK。

---

## 2. 主循环：它怎么跑一个任务

### 2.1 分层结构

```
run()               外层循环：并发信号处理、事件发送、收尾（~300 行）
  └ _execute_step() step 级超时（默认 180s）、浏览器断连重试
      └ step()      单步三段式：
          _prepare_context(step_info)   # 观测 + 压缩 + 组装输入
          _get_next_action()            # LLM 调用 + 解析 + 兜底
          _execute_actions()            # 执行动作（含 multi_act 闸门）
          _post_process()
        finally: _finalize()            # 写历史、计数 +1、发事件
```

关键细节：`last_model_output / last_result` 在 LLM 调用**之前**就被清空（`agent/service.py:1071-1072`），注释说明是防止超时后残留上一步的脏数据。所有异常统一进 `_handle_step_error`，**不抛到 run 层** —— 单步失败 = 记一次 failure 继续跑。

### 2.2 停止条件（只有 3 个硬停）

| 条件 | 实现 |
|---|---|
| 模型调用 `done` | 检查最后一个 ActionResult.is_done（`agent/views.py:722-727`） |
| 连续失败超限 | `consecutive_failures >= max_failures(5) + final_response_after_failure(1)` = 6 次（`service.py:2630-2631`） |
| 步数耗尽 | `while n_steps <= max_steps` 的 `else` 分支写一条 error 历史（`service.py:2654-2670`） |
| （外部）stop / pause / 回调 | `_check_stop_or_pause()` 抛 `InterruptedError` |

### 2.3 双层超时（很实用的工程细节）

- **step 级** 180s：超时后 `consecutive_failures += 1` 且手工 `n_steps += 1` 兜底（`service.py:2481-2497`）；
- **LLM 级** 60s：超时给模型的错误文案是"Keep your thinking and output short"（`service.py:1188-1199`）；
- **action 级** 180s：专门防 CDP WebSocket 假死（`tools/service.py:2188-2249`）。

### 2.4 `multi_act` 的两道「页面变更闸」（最聪明的防错设计）

模型一步可以输出多个动作，但前一个动作可能已经改变了页面（index 全部失效）。它做了两层拦截（`agent/service.py:2839-2853`）：

```python
# Layer 1: 静态标记 —— 注册动作时声明 terminates_sequence
registered_action = self.tools.registry.registry.actions.get(action_name)
if registered_action and registered_action.terminates_sequence:
    break
# Layer 2: 运行时检测 —— 执行后比对 URL 和 focus target
post_action_url = await self.browser_session.get_current_page_url()
post_action_focus = self.browser_session.agent_focus_target_id
if post_action_url != pre_action_url or post_action_focus != pre_action_focus:
    break
```

`terminates_sequence=True` 的动作：navigate / search / go_back / switch / evaluate（`tools/registry/views.py:22-24`）。

---

## 3. 上下文管理（这是 page-agent 最缺的一整块）

### 3.1 消息永远是 3 段，不是对话数组

```python
# agent/message_manager/views.py:66-83
class MessageHistory(BaseModel):
    system_message: BaseMessage | None = None
    state_message: BaseMessage | None = None
    context_messages: list[BaseMessage] = Field(default_factory=list)
    def get_messages(self) -> list[BaseMessage]:
        ...
        # [system, state, *context]
```

每步**覆盖** `state_message`（`message_manager/service.py:556-568`），`context_messages` 每步 `clear()`（`:208`）。历史被渲染成文本塞进 `<agent_history>`。

**收益**：token 结构与步数几乎无关（只受历史文本长度影响）；system/state 标 `cache=True`（`agent/prompts.py:57,504,506`），prefix cache 极其友好。
**代价**：模型看不到"真实的上一轮 assistant 消息"，必须靠 `<agent_history>` 文本化 —— 也因此**历史渲染会延迟一步**（第 N 步结果在第 N+1 步开头才写进去，`service.py:1130`）。

### 3.2 裁剪：保留 first + "N steps omitted" + 最近 N-1

```python
# message_manager/service.py:176-187
omitted_count = total_items - self.max_history_items
items_to_include = [
    self.state.agent_history_items[0].to_string(),   # 保留初始化
    f'<sys>[... {omitted_count} previous steps omitted...]</sys>',
]
items_to_include.extend(item.to_string() for item in self.state.agent_history_items[-(self.max_history_items - 1):])
```

### 3.3 字符预算（没有 token 计数器，全是字符截断）

| 内容 | 上限 | 位置 |
|---|---|---|
| `read_state_description` | 60k 字符 | `message_manager/service.py:350-356` |
| `action_results` | 60k 字符 | `:364-367` |
| DOM 可交互元素 | 40k 字符（默认 `max_clickable_elements_length`） | `agent/prompts.py:252-256` |
| 错误信息 | >200 字符则取头 100 + `......` + 尾 100 | `message_manager/service.py:342-347` |

注意最后一条：**保头保尾**的裁剪，比单纯截断更聪明（异常栈的关键信息通常在末尾）。

### 3.4 LLM compaction（摘要压缩）—— 双闸触发

```python
# message_manager/service.py:233-242
steps_since = step_info.step_number - (self.state.last_compaction_step or 0)
if steps_since < settings.compact_every_n_steps: return False        # 默认 25 步
full_history_text = '\n'.join(item.to_string() for item in history_items).strip()
if len(full_history_text) < trigger_char_count: return False          # 默认 40000 字符 ≈ 10k token
```

两个门槛**都过**才触发（避免每步都额外调一次 LLM）。压缩后：

```python
# :293-298
keep_last = max(0, settings.keep_last_items)        # 默认 6
self.state.agent_history_items = [history_items[0]] + history_items[-keep_last:]
```

摘要 prompt 写得很克制（`:262-270`）：*"Only mark as COMPLETED what you saw explicit success confirmation for. Otherwise mark as IN-PROGRESS. Never infer completion from context."*；渲染时再套 `<compacted_memory>` 并加免责声明「未经核实、不要在 done 里当成自己完成的事」（`:156-163`）。

**可配置**：`MessageCompactionSettings`（`agent/views.py:35-56`）—— `enabled / compact_every_n_steps=25 / trigger_char_count=40000 / keep_last_items=6 / summary_max_chars=6000 / compaction_llm`。

### 3.5 `read_state`：一次性信息通道（最精妙的一处）

ActionResult 有三个语义字段：

| 字段 | 语义 | 去向 |
|---|---|---|
| `long_term_memory` | 永久记忆 | 进 `<agent_history>`，永不消失 |
| `extracted_content` + `include_extracted_content_only_once=False` | 普通结果 | 进本步 action_results |
| `extracted_content` + `include_extracted_content_only_once=True` | **只看一次** | 进下一步 `<read_state>`，之后清空 |

```python
# message_manager/service.py:322-326
if action_result.include_extracted_content_only_once and action_result.extracted_content:
    self.state.read_state_description += f'<read_state_{idx}>\n{action_result.extracted_content}\n</read_state_{idx}>\n'
```

典型用法（`extract` 动作，`tools/service.py:1266-1290`）：内容 <1 万字符就进 `long_term_memory`；否则**先落盘成文件**，历史里只留「Query: X / Content in file.md and once in `<read_state>`」，全文只读一次。

**这一条直接解决了「大块内容要么永久占 token、要么模型忘了」的两难。**

### 3.6 其他省 token 手段

- **长 URL 缩短 + 输出回填**：query/fragment 超 25 字符截断 + md5 前 7 位，模型输出里再递归还原（`service.py:1791-1836, 1956-1958`）；
- **截图 `use_vision` 三态**：True / False / `'auto'`（只在动作显式请求截图时附图，`message_manager/service.py:461-478`）；
- **prompt 8 个变体**：按模型 / thinking / flash 切换（`prompts.py:60-90`），flash 变体把 schema 砍到只剩 `memory + action`（`views.py:457-473`）。

---

## 4. 工具体系：装饰器 + 单键 Union + 域过滤

### 4.1 注册（`tools/registry/service.py:291-327`）

```python
@registry.action(description='Click element by index', param_model=ClickElementAction)
async def click(params: ClickElementAction):
    ...
```

支持两种签名风格（`def act(params)` 或 `def act(a: int, b: str)`），用 `inspect.signature` 自动生成 param_model；**特殊参数按名字注入**（`context / browser_session / page_url / cdp_client / page_extraction_llm / file_system / ...`，`registry/views.py:157-182`），明确禁止 `**kwargs`。

### 4.2 ActionModel：每步按当前 URL 重建的「单键 pydantic Union」

```python
# registry/service.py:553-565
for name, action in available_actions.items():
    individual_model = create_model(
        f'{name.title().replace("_", "")}ActionModel',
        __base__=ActionModel,
        **{name: (action.param_model, Field(description=action.description))},
    )
```

无 discriminator，靠「哪个字段有值」隐式判别；>1 个动作时用 `RootModel[Union[...]]` 包一层。**每步按当前 URL 重新构造**（`service.py:4049-4068`），从而支持「域限定工具」（例如只在 `*.google.com` 出现的动作）。

### 4.3 内置 26 个动作

`search / navigate / go_back / wait / click / input / upload_file / switch / close / extract / search_page / find_elements / scroll / send_keys / find_text / screenshot / save_as_pdf / dropdown_options / select_dropdown / write_file / replace_file / read_file / evaluate / done`

工程痕迹两例：

- `ClickElementAction` 同时给 `index` 和 `coordinate`（`tools/views.py:69-74`），点 `<select>` 会被拦截并自动降级成"取下拉选项"（`tools/service.py:736-749`）；
- `NoParamsAction` 强行加一个可选 `description` 字段，注释直说是 **Gemini 对空对象 schema 报错**的兼容 hack（`tools/views.py:145-149`）—— 多 provider 场景迟早会遇到。

### 4.4 `done` 的语义

- 无 structured output：`DoneAction{text, success=True, files_to_display}`；
- 有 `output_model_schema`：注册 `StructuredOutputAction[output_model]`，`success/files_to_display` 从 schema 里隐藏，返回 `data` 的 JSON（`tools/service.py:2016-2045`）；
- **强校验**：`ActionResult` 的 model_validator 要求 `success=True` 必须伴随 `is_done=True`，普通动作不许设 success（`agent/views.py:340-349`）。

---

## 5. 模型输出解析与容错

### 5.1 唯一入口

`llm.ainvoke(messages, output_format=AgentOutput)` 直接返回 pydantic 实例（`service.py:1950-1954`），各 provider 自己实现结构化输出。

### 5.2 三家三种机制

| Provider | 机制 | 兜底 |
|---|---|---|
| OpenAI 系 | `response_format={type:'json_schema', strict:true}` | `finish_reason=='length'` 抛 `ModelOutputTruncatedError`（`llm/openai/chat.py:222-232`） |
| Anthropic 系 | **工具调用伪装**：造名叫 `AgentOutput` 的 tool + `tool_choice` 强制 | **3 级抢救**：tool_input 校验 → 从 `thinking` 字段里正则/JSON 捞回（Claude 把 tool call 写成文本的著名故障）→ 从纯文本抽 JSON（`llm/anthropic/chat.py:307-367`） |
| Gemini | `response_mime_type=json + response_schema` | 从文本解析（`llm/google/chat.py:381-401`） |

### 5.3 `SchemaOptimizer`（`llm/schema.py`）—— 多 provider 结构化输出的前提

1. 内联所有 `$ref/$defs`；
2. 给所有 object 强制 `additionalProperties: false`；
3. **把所有 properties 都塞进 `required`**（OpenAI strict 模式要求），再由调用方剥掉 `minItems/default`。

### 5.4 空动作三级兜底（必抄）

```python
# agent/service.py:1675-1700
if (not model_output.action or all(action.model_dump() == {} for action in model_output.action)):
    clarification_message = UserMessage(content='You forgot to return an action. Please respond with a valid JSON action...')
    model_output = await self.get_model_output(input_messages + [clarification_message])
    if not model_output.action or all(action.model_dump() == {} for action in model_output.action):
        action_instance = self.ActionModel()
        setattr(action_instance, 'done', {... 'success': False, 'text': 'No next action returned by LLM!'})
        model_output.action = [action_instance]
```

### 5.5 失败矩阵

| 故障 | 处理 |
|---|---|
| LLM 超时 60s | 抛 TimeoutError，文案提示缩短输出 |
| step 超时 180s | `consecutive_failures += 1` + 步数兜底 |
| action 超时 180s | 转成 `ActionResult(error)` 让模型自我恢复（不中断） |
| 空 action | 澄清重试 1 次 → 合成 `done(success=False)` |
| 429/401/402/5xx/截断 | **切 fallback_llm，此后整轮都用它**，只切一次（`service.py:1981-2023`） |
| 浏览器连接断开 | 若正在重连则最多等 `RECONNECT_WAIT_TIMEOUT`，成功后"retrying step" |
| 其他异常 | 记 failure，转成 ActionResult(error) 让模型看到 |

---

## 6. DOM 层：从「注入 JS」进化到「CDP 三棵树」

这是 0.5.9 → 0.13 最大的代差。page-agent 移植的是**老版本**。

### 6.1 三路并行 + 分层降级

```python
# browser_use/dom/service.py:590-598
tasks = {
    'snapshot': create_task(create_snapshot_request()),      # DOMSnapshot.captureSnapshot(includePaintOrder=True)
    'dom_tree': create_task(create_dom_tree_request()),      # DOM.getDocument(depth=-1, pierce=True)
    'ax_tree': create_task(self._get_ax_tree_for_all_frames(target_id)),
    'device_pixel_ratio': create_task(self._get_viewport_ratio(target_id)),
}
done, pending = await asyncio.wait(tasks.values(), timeout=10.0)
```

- 超时后对未完成项**逐个重试**（再给 2s）；
- `snapshot` / `dom_tree` 失败才致命，**ax_tree 失败降级为空树**（注释：没有 AX 也要保住 DOM 结构）；
- 只取 10 个 computed style（`enhanced_snapshot.py:17-29`，注释写着"防止重页面把 Chrome 搞崩"）。

三棵树在 **backendNodeId** 上汇合（`service.py:798-812`）。

### 6.2 `paint_order`：遮挡判断（page-agent 完全没有）

CDP 的 `layout.paintOrders` 给出每个节点的绘制序号（**数值越大越在上层**），browser-use 用它做几何遮挡计算：

```python
# dom/serializer/paint_order.py:189-223
for paint_order, nodes in sorted(grouped_by_paint_order.items(), key=lambda x: -x[0]):  # 降序
    rects_to_add = defaultdict(list)
    for node in nodes:
        rect = Rect(x1=b.x, y1=b.y, x2=b.x+b.width, y2=b.y+b.height)
        context = self._document_context(node)
        if rect_unions[context].contains(rect):        # ← 判遮挡就这一行
            node.ignored_by_paint_order = True
        if (background-color == 'rgba(0, 0, 0, 0)' or opacity < 0.8):
            continue                                   # 透明/半透明不参与遮挡
        rects_to_add[context].append(rect)
    for context, rects in rects_to_add.items():
        for rect in rects: rect_unions[context].add(rect)   # 同层批量加，避免兄弟互遮
```

判定语义：**元素的矩形若被「paint_order 更高、且不透明」的所有元素矩形的并集完全覆盖 → 被挡住 → 不给 index**。

底层是一个 ~120 行的**矩形并集/差集**引擎（`RectUnionPure`）：`_split_diff(a,b)` 把 a−b 拆成最多 4 块，`contains(r)` 用「碎片化消解」判断是否被完全吃掉。实测成本（随机方块）：1000 个不透明块 ≈ 40ms，2000 ≈ 78ms，5000 ≈ 201ms；有 `_MAX_RECTS=5000` 保险丝（触顶后**保守地认为没被遮挡**，不误删）。

两个必须保留的正确性细节：
1. **同 paint_order 批量 add**，否则同一层的兄弟元素会互相判死；
2. **按 `(session_id, frame_id)` 分桶**，跨 iframe 坐标空间不同，不能互相比较。

### 6.3 `index` = CDP backendNodeId（不是 0 基连续编号）

```python
# dom/serializer/serializer.py:649-658
def _allocate_selector_index(self, backend_node_id: int) -> int:
    if backend_node_id not in self._selector_map:
        return backend_node_id          # ← 正常情况 index 就是 backendNodeId
    while self._next_synthetic_index in self._reserved_backend_node_ids:
        self._next_synthetic_index += 1
    ...                                  # 撞号（跨 iframe target 的 nodeId 空间）才合成
```

**为什么重要**：index 跨 step 稳定 → 模型历史里引用旧 index 仍指向同一元素。而 page-agent 每帧从 0 重排（`highlightIndex++`），历史 index 会漂移误点。代价是编号不连续（`[101] [103] [104]`），需要在 prompt 里说明。

### 6.4 给模型的 DOM 表示（真实 serializer 输出）

```
Clicks:
DOM Serializer Test Page
Regular DOM Elements
[101]<button id=regular-btn-1 />
	Regular Button 1
[103]<input id=regular-input type=text placeholder=Regular input />
[104]<a id=regular-link />
	Regular Link
Shadow DOM Elements
Open Shadow
	[106]<button id=shadow-btn-1 />
		Shadow Button 1
Shadow End
Same-Origin Iframe
|scroll element[119]<iframe id=same-origin-iframe /> (scroll)
	[114]<button id=iframe-btn />
		Iframe button...
```

格式规则（`serializer.py:989-1201`）：

| 元素 | 标记 |
|---|---|
| 可交互 | `{indent}{*}{[index]}<tag attr=val />`，文本节点单独下一行、缩进 +1 |
| 可滚动 | 前缀 `\|scroll element`，后缀 `(x pages above, y pages below)` |
| iframe | `\|IFRAME\|<iframe ...>` |
| shadow host | `\|SHADOW(open)\|` / `\|SHADOW(closed)\|`，root 输出成 `Open Shadow` … `Shadow End` |
| 新元素 | `*[index]` |
| svg | 折叠成 `<!-- SVG content collapsed -->` |
| 视口外内容 | `... (3 more elements below - scroll to reveal): <button> "x" ~1.4 pages down` |

属性策略（`dom/views.py:18-82`）：白名单约 40 项，**`class` 和 `href` 都不在**（有争议，见坑）；值截断 100 字符；同值去重；`role==tag` 删除；password 的 value **永不输出**，且敏感 input 的 live value 在 snapshot 构建期就丢弃（`enhanced_snapshot.py:48-67`）。

### 6.5 0.5.9 → 0.13.14 进化对照（page-agent 抄漏了什么）

| 维度 | page-agent（0.5.9 移植） | browser-use 0.13.14 |
|---|---|---|
| 取 DOM | 注入 JS 遍历 | CDP 三棵树（DOMSnapshot + getDocument(pierce) + AX） |
| 遮挡判断 | `elementFromPoint` 采样；**全页模式下直接关掉** | paintOrders + 矩形并集几何减法，永远开启 |
| index | 每帧从 0 连续递增 | = backendNodeId，跨 step 稳定 |
| 跨域 iframe | 无 | 另开 target 递归整棵 DOM（深度/数量上限+去重） |
| shadow | 只能 open | open + **closed**（CDP 层面可见），显式标注 |
| AX 树 | 不用 | 合并全 frame，拿 disabled/checked/expanded 的**实时状态** |
| 新元素标记 | `WeakMap<Element, url>` | 上一步 `(session_id, backendNodeId)` 集合差集 |
| 属性截断 | 20 字符 | 100 字符 |
| bbox 传播过滤 | 无 | 有（`excluded_by_parent`，解决"卡片里 20 个 span 全编号"） |

---

## 7. 浏览器会话层：事件总线 + 12 个 watchdog

- **`bubus` 事件总线**：46 个事件类型（`browser/events.py:51-620`），`ClickElementEvent / TypeTextEvent / BrowserStateRequestEvent / TabCreatedEvent / AgentFocusChangedEvent / TargetCrashedEvent / NavigationCompleteEvent / FileDownloadedEvent` … 所有动作都是"发事件 → watchdog 处理 → 回事件"。
- **`ResilientEventBus`**（`browser/session.py:113-138`）：总线已被 close（长驻会话冷恢复）时**静默 no-op 而不是 assert** —— 长驻会话架构迟早要踩的补丁。
- **CDP 连接**：`TimeoutWrappedCDPClient`，`max_ws_frame_size=200MB`（大 DOM）、http URL 自动换 ws、`Target.setAutoAttach(flatten=True)`。
- **焦点纪律**：**只允许 page 类型 target 拿到 agent 焦点**，iframe/worker 的焦点请求会被忽略（`session.py:1553-1572`）——它们随时 detach，焦点指过去就死。
- **watchdog 状态机**：DOM watchdog 在 `BrowserStateRequestEvent` 里 → 非 http 页面走快路径（省一次 CDP）→ **DOM 构建与截图并行** → 截图有剩余预算控制（30s 总预算减去已花时间）→ 组装 BrowserStateSummary。计时埋点细到 `calculate_paint_order` / `create_simplified_tree` 每一步。
- 多标签：`get_tabs()` 派生 `TabInfo(target_id, url, title)`；chrome:// 页面用 URL 当 title。

---

## 8. 规划 / 反思 / 裁判

### 8.1 循环检测：**有，但只软不硬**

`ActionLoopDetector`（`agent/views.py:157-248`）：

- 动作哈希**归一化**：search 排序 token、click/input 只按 index、navigate 用完整 URL、scroll 按方向；
- 窗口 20，阈值 **5 / 8 / 12** 次逐级升级提示；
- 页面停滞：DOM 文本 + URL + 元素数做 sha256 指纹，连续 5 次相同 → 提示；
- 豁免 `wait / done / go_back`；
- 每步只注入一条 UserMessage 提示 —— **不会强制停止**。

### 8.2 规划：模型自驱，代码只提供惯性

- 输出字段 `current_plan_item: int|None` + `plan_update: list[str]|None`（`agent/views.py:395-396`）；
- 代码把 plan 渲染成 `[x]/[>]/[ ]/[-]` 塞进 `<plan>`；`current_plan_item` 前进时自动把中间项标 done；
- 两个 nudge：连续失败 ≥3 → "REPLAN SUGGESTED"；走满 5 步还没有 plan → "PLANNING NUDGE"；
- **flash 模式直接关掉 planning**（`service.py:242-244`）。

### 8.3 软控制全家桶（值得抄的"控制面"思路）

| 时机 | 动作 |
|---|---|
| 步数到 75% | 注入预算警告："到 75% 时评估剩余步数能否完成"（prompt 与代码双侧实现） |
| 连续失败 ≥3 | 注入"建议重新规划" |
| 5 步无 plan | 注入"建议先规划" |
| 动作重复 5/8/12 次 | 注入循环提示 |
| 最后一步 | 把 `AgentOutput` 换成 `DoneAgentOutput`（只暴露 done） |

**硬停只有 3 个，其余全是"往 context_messages 塞一条 UserMessage"** —— 让模型自己收口，而不是突然掐断。

### 8.4 judge.py：事后 LLM 裁判，**不接管结果**

- 输入：task + 全部 agent_steps（各截 40k）+ 最近 10 张截图 + 可选 ground_truth；
- 输出：`{reasoning, verdict, failure_reason, impossible_task, reached_captcha}`；
- 判据：5 级排序（Task Satisfaction > Output Quality > Tool Effectiveness > Agent Reasoning > Browser Handling）+ 自动判 false 清单（captcha / 缺认证 / 格式错 / 死循环 / 编造内容 / 提前 done）；
- **关键设计**：judge verdict **不覆盖** agent 自报的 success，两者并存进 telemetry 供对比，只在分歧时告警（`service.py:1629-1641`）。

---

## 9. ⭐ 可借鉴清单（按价值排序）

| # | 借鉴点 | 解决什么问题 | 落地/成本/风险 |
|---|---|---|---|
| 1 | **「system + 单一可变 state + context」消息结构**（`message_manager/views.py:66-83`） | token 随步数线性增长、prefix cache 频繁失效 | 中成本、低风险。易变字段放消息末尾，system/state 标 cache |
| 2 | **`paint_order` 遮挡过滤**（`dom/serializer/paint_order.py` + CDP `includePaintOrder`） | 「点了看不见的元素」这类最伤体验的错 | 低-中成本（225 行 + 几何引擎 120 行，零依赖，可直接翻 TS）。必保留同层批量 add 与按 document 分桶 |
| 3 | **`long_term_memory` / `extracted_content(only_once)` + `<read_state>`**（`message_manager/service.py:322-340`） | 大块工具结果要么永久占上下文、要么模型忘了 | 低风险。>10k 字符自动落盘 + 只读一次 |
| 4 | **index = 稳定 backendNodeId**（`serializer.py:649-658`） | 每帧重排导致历史 index 漂移误点 | 低-中成本。前端拿不到 backendNodeId 就退回「元素→稳定 id」的 WeakMap |
| 5 | **注入式软控制**：75% 预算警告 / 循环 5-8-12 级 / 重规划 / 末步强制 done | 硬 max_steps 硬停会丢进度，不提示会跑到耗尽 | 低成本，**建议立刻抄 75% 警告 + 末步强制 done** |
| 6 | **动作序列两道页面变更闸**（`terminates_sequence` + URL/focus 比对） | 多动作批量执行时后续 index 失效误点 | 低成本 |
| 7 | **LLM compaction 双闸**（25 步 + 40k 字符，保留 first + last 6） | 长任务历史无界 | 中成本、中风险（会丢事实，需可关闭 + 原始历史落盘） |
| 8 | **bbox 传播过滤**（`excluded_by_parent`） | 卡片里 20 个 span 全给编号 | 中成本，收益明显 |
| 9 | **空动作三级兜底**（澄清重试 → 合成 `done(success=false)`） | 小模型/长上下文常返回空 action | 极低成本，**必抄** |
| 10 | **`SchemaOptimizer`**（内联 `$ref`、全 required、按 provider 剥 minItems/default） | 多 provider 结构化输出兼容地狱 | 中成本、低风险 |
| 11 | **长 URL 缩短 + 输出回填**（25 字符阈值 + md5(7)） | 带 query 的 URL 反复出现吃 token | 低成本；**只在结构化字段里还原，别全局替换** |
| 12 | **judge 只评估不接管** | self-report 不可信，但直接覆盖会引入新不确定性 | 低风险，两个字段并存、分歧告警 |
| 13 | **循环检测的动作哈希归一化** | 模型换个说法重复做同一件事 | 低成本；要配套**硬阈值**（见坑） |
| 14 | **视口阈值 + 隐藏内容提示**（`viewport_threshold=1000px`，`(3 more elements below - scroll to reveal)`） | DOM 无限长 vs 完全截断 | 低成本，比硬截断友好 |
| 15 | **元素指纹 5 级重匹配**（EXACT hash → STABLE hash → XPATH → AX_NAME → ATTRIBUTE，`service.py:3554+`） | 「录一次、可重放」 | 中成本；也是 page-agent 缺的 |
| 16 | 工程细节合集 | — | `NoParamsAction` 的 Gemini 兼容 hack；`ResilientEventBus` 下线即 no-op；错误信息保头保尾 |

---

## 10. 不要抄的坑

| # | 坑 | 证据 | 正确做法 |
|---|---|---|---|
| 1 | **4188 行 god object `Agent`**：run/step/rerun/GIF/云同步/信号/费用全在一个类；`beta/` 又复制一遍到 6810 行 | `agent/service.py` | 拆 run / step / context / observability |
| 2 | **双历史冗余**：`HistoryItem`（文本，喂模型）与 `AgentHistoryList`（结构化，喂 UI/rerun/judge）各存一份，且文本版**延迟一步** | `service.py:1130` | 单一真源 + 派生视图 |
| 3 | **循环检测只软不硬**：重复 12 次仍只是提示，长跑照样烧钱 | `views.py:211-248` | 加硬阈值：连续 N 步无进展 → 强制 `done(false)` |
| 4 | **compaction 默认开启且不可回溯**：每 25 步同步阻塞一次额外 LLM 调用；摘要不可逆丢事实 | `views.py:35-56` | 原始历史落盘可回溯 + 干净的 `enabled=False` 路径 |
| 5 | **registry 的 inspect 签名 DI 太"魔法"**：按参数名注入，重命名即静默失败；禁止 `**kwargs` 反而别扭 | `registry/service.py:66-79` | 显式 `ToolContext` 单参数 |
| 6 | **单键 Union + `extra='forbid'` 报错难读**：模型给两个键或错键名时，pydantic 吐出长串 union 分支错误 | `llm/openai/chat.py:301` | 解析失败要能「回喂错误」给模型 |
| 7 | **失败计数口径不一致**：只有"单动作 step 且该动作 error"才 `consecutive_failures += 1`，多动作 step 的错误不计数 | `service.py:1234-1243` | 统一口径 |
| 8 | **paint_order 的"vibes"阈值**：`opacity < 0.8` 才参与遮挡 → 半透明蒙层会被当遮挡物把所有底下元素判死 | `paint_order.py:207-217` | 阈值做成配置；半透明蒙层单独处理 |
| 9 | **`_MAX_RECTS=5000` 触顶静默失效**：从"积极过滤"变"完全不过滤"，无日志 | `paint_order.py:115-117` | 加计数指标 |
| 10 | **paint_order 成本**：实测 2000 块 ≈ 78ms、5000 ≈ 201ms，纯同步循环 | 自测 | 前端移植需分片/Worker |
| 11 | **serializer 长尾特判不可移植**：强制 file input 可见、dropdown class 白名单、日期格式硬猜……全是真实站点打的补丁，无测试 | `serializer.py:519-531, 703-736, 1226-1292` | 只抄主干规则 |
| 12 | **搜索框关键词启发式**（class/id 含 search\|find\|query 就算可交互） | `clickable_elements.py:76-103` | 误报率高，不建议抄 |
| 13 | **`href` 不在属性白名单**：`<a>` 变成没有目标，模型无法判断跳转去向 | `dom/views.py:18-82` | 加回 href |
| 14 | **`max_clickable_elements_length` 按字符硬截断**：可能把 `<button` 切一半 | `prompts.py:254-259` | 按行/按子树截断 |
| 15 | **每个 step 都可能重开 websocket**（TODO 挂着）+ session 轮询 20×100ms 等 attach | `service.py:51`、`session.py:1498-1546` | 连接复用 + 事件等待 |
| 16 | **每个 step 强制截图**（即使 `use_vision=False`，注释说是为了 cloud sync 好看） | `service.py:1097-1100` | 按需截图 |
| 17 | **深度绑定自家云生态**：cloud_events / skills / telemetry / `ChatBrowserUse` 分支散落主循环 | `service.py:1616-1619` 等 | 先切开再复用 |
| 18 | `python_highlights.py`（546 行）与 `beta/service.py`（6810 行）都是**别当真**：前者已死代码，后者是并行实验实现 | grep 无引用 | 别读别抄 |

---

## 11. 怎么用

### 如果你要做「长任务浏览器 Agent」

抄 1 → 3 → 5 → 9 就能把「上下文爆炸 + 卡死 + 空动作」三大高频问题按死；DOM 层直接抄 2 + 4。

### 如果你只想学 Agent 架构

按这个顺序读：

1. `agent/message_manager/views.py`（66-83 行，消息结构）→ 理解它为什么不用对话数组；
2. `agent/message_manager/service.py:216-302`（compaction）→ 长任务上下文的唯一正解；
3. `agent/service.py:1036-1086`（step 三段式）+ `:2839-2853`（多动作闸门）；
4. `tools/registry/service.py:519-605`（单键 Union）；
5. `dom/serializer/paint_order.py`（225 行，纯算法，最好读）；
6. `llm/schema.py`（结构化输出的多 provider 兼容）。

### 如果你在对比 page-agent

两者是**互补**关系：

- page-agent = 纯前端 in-page，无 CDP，靠注入 JS，优势是"任何网页一行 script 就能用"；
- browser-use = 服务端 CDP，能力完整（多 tab、跨域 iframe、closed shadow、真实键盘），代价是要跑浏览器进程；
- **DOM 层看 browser-use 0.13，Agent/上下文层看 browser-use，产品化/集成体验看 page-agent。**

---

## 12. 一句话总结

> browser-use 的真正竞争力不在 DOM 提取（那套启发式谁都能抄），而在**上下文工程**：单一可变 state 消息、`read_state` 一次性通道、双闸 compaction、注入式软控制 —— 这四件事决定了它能不能跑 50 步以上的任务。DOM 层的 `paint_order` 是第二个护城河，纯几何、零依赖、可独立移植。
