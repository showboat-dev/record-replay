# Playwright 深度分析报告

> 评估对象：https://github.com/microsoft/playwright（v1.65.0-next，Apache-2.0，commit `deb7e86`）
> 分析时间：2026-11-01 ｜ 方式：浅克隆精读（`/tmp/playwright`，packages 下 TS 约 **29.3 万行**）
> 复现：`git clone --depth 1 https://github.com/microsoft/playwright.git /tmp/playwright`
> 定位：这不是"一个测试工具"，而是**一套跨语言、跨浏览器的 RPC 运行时**，测试框架只是它的第一个消费者。

---

## 0. TL;DR

| 维度 | 结论 |
|---|---|
| **它是什么** | 三件套：① 浏览器自动化库（client/server RPC）② 测试框架（fixture/worker/并行/reporter/trace）③ 代码生成与录制 |
| **最值得学的 3 件事** | ① **单一 schema 生成全链路 RPC**（一份 yaml → 5 份代码，本地/远程/多语言全免费）；② **`progress.race` 单点超时**（一个 timer 打断任意深度的 await）+ 三层退避重试；③ **fixture 依赖图 + workerHash**（让"并行"从配置问题变成可计算的内容哈希） |
| **最被低估的资产** | **aria snapshot**：`- button "Submit" [ref=e2]` —— 给 LLM 看的页面表示，现在几乎所有 browser agent（含 MCP 服务）都在借这套 |
| **最不该学的** | 三份手写引擎注册表、`frames.ts` 1936 行上帝类、四套并存的超时实现、手写 ANSI 光标控制、`fn.toString()` 正则解析 fixture 依赖 |
| **一句话** | Playwright 的核心竞争力不是 API 好用，而是**把"不可靠的浏览器"变成了"可解释的状态机"**：每次操作都有 deadline、每步失败都有 call log、每个快照都可回放。 |

---

## 1. 项目画像

**包结构**（`packages/`，24 个包）：

```
playwright-core/     # 引擎：client + server + 驱动 + injected（最核心）
  ├ client/          # 用户 API 那一侧（Connection / ChannelOwner / locator / page）
  ├ server/          # 真正干活那一侧（frames / dom / dispatchers / chromium / firefox / webkit / bidi / trace）
  ├ injected/        # ← 注入到浏览器里的脚本（selector / aria / actionability）
  └ utils/ isomorphic/
protocol/            # 协议：spec/*.yml + 生成的 validator.ts（3242 行）
playwright/          # @playwright/test：fixture / worker / dispatcher / reporters / matchers / mcp
playwright-client/   # 轻客户端
injected/            # 构建产物：注入脚本 bundle（由 utils/generate_injected.js 生成）
trace-viewer/  html-reporter/  recorder/  web/  extension/  dashboard/
```

**版本与节奏**：`1.65.0-next`，每周发版，issue/PR 量极大（commit `deb7e86` 是"扩展允许禁用受控标签组"）。

---

## 2. 架构：三种部署模式，只换一个 transport

### 2.1 一张图

```
用户代码
  │  client API（Page / Locator / expect）
  ▼
Connection ◄── channel RPC（{id, guid, method, params, metadata}）──► DispatcherConnection
  ▲                                                                    │
  │ in-process: 两个 Connection 直接对接（setImmediate）                 ▼
  │ out-of-process: fork(cli.js run-driver) + stdin/stdout JSON      server 实现
  │ remote: WebSocket（playwright server）                            （Browser/Context/Page）
  └────────────────────────────────────────────────────────────────────┘
```

### 2.2 in-process（`require('playwright')` 默认）

`packages/playwright-core/src/inprocess.ts:27-50`：

```ts
const clientConnection = new Connection();
clientConnection.useRawBuffers();                       // binary 走 Buffer，不 base64
const dispatcherConnection = new DispatcherConnection();
dispatcherConnection.onmessage = message => clientConnection.dispatch(message);
clientConnection.onmessage = message => dispatcherConnection.dispatch(message);
...
// 初始化完成后切异步，避免回调里再发 RPC 造成同步重入
dispatcherConnection.onmessage = message => setImmediate(() => clientConnection.dispatch(message));
```

细节很讲究：初始化阶段必须**同步**（否则拿不到 root 对象），之后切 `setImmediate` 打破同步重入。

### 2.3 out-of-process（driver 子进程）

`outofprocess.ts:41-62` fork 一个 driver，`cli/driver.ts:30-53` 里：

```ts
const transport = new PipeTransport(process.stdout, process.stdin);
process.stdout.on('error', () => {});   // 父进程先退时忽略 EPIPE，等 stdin 关闭再优雅退出
```

`driver.ts:54-58` 还刻意吞掉 SIGINT —— **退出只由 stdin 关闭触发**，保证父进程死了不会留孤儿浏览器。
**为什么要有它**：Python/Java/.NET 的 binding 只需要 fork driver + stdio JSON，不必各自实现 CDP。

### 2.4 远程 `playwright server`

关键认知：**远程不是"多一个 channel 方法"**。`client/connect.ts:60-95` 在拿到 ws 地址后**新建第二条 Connection** 并 `markAsRemote()`，之后所有 `page.click` 走这条连接。所以 `connection.ts:145-151` 的 `isRemote` 就是"这条连接是否跨进程"。

server 侧 5 种模式（`remote/playwrightServer.ts:94-183`）：extension 复用 / extension debug-controller / launchServer / launchServerShared / default launch。语义差异被显式化成 option（`server/playwright.ts:37-41`）：

```ts
{ sdkLanguage, isInternalPlaywright?, isServer?, isClientCollocatedWithServer? }
```

例如 `server/fileUploadUtils.ts:39-40`：`if (localPaths && !isClientCollocatedWithServer) throw new Error('localPaths are not allowed when the client is not local')` —— **"本地能跑、远程就坏"的代码路径，在唯一入口显式拦掉**。

---

## 3. 一次 `page.click()` 到底发生了什么

| 步 | 位置 | 内容 |
|---|---|---|
| ① | `client/page.ts:730` | `Page.click` → `this._mainFrame.click(...)` |
| ② | `client/frame.ts:321-323` | `this._channel.click({ selector, ...options }, this._timeout(options))`；默认 timeout 30000（`isomorphic/time.ts:39`） |
| ③ | `client/locator.ts:122-124` | Locator 路径额外带 `strict: true` |
| ④ | `client/channelOwner.ts:157-179` | Proxy 拦方法 → validator 校验 params → `_wrapApiCall` 记录调用上下文 |
| ⑤ | `client/connection.ts:196-208` | 出网帧 `{ id, guid, method, params, metadata }` |
| ⑥ | `server/dispatchers/dispatcher.ts:297-399` | 校验 → CallMetadata → `onBeforeCall` → `controller.run(..., metadata.timeout)` → Result 校验 → 异常序列化 |
| ⑦ | `server/frames.ts:1254-1256` | 进入真正的动作层（见 §6） |
| ⑧ | 返回值 | `FrameClickResult = tOptional(tObject({}))` → **空对象** |

**两个值得学的设计**：

1. **timeout 不在 params 里，在 metadata 里**（`connection.ts:196-208`）。协议方法签名保持纯业务参数；超时/标题/调用点/是否 internal 这些横切信息走统一 metadata 通道。
2. **懒事件订阅**：`client/channelOwner.ts:72-76` 在首次 `on()` / 末次 `off()` 时发 `updateSubscription`；server 只在 `Set` 里有订阅者时才发事件（`browserContextDispatcher.ts:206-214`）。`page.on('request')` 这种高频事件没订阅就一个字节都不传。

---

## 4. 协议：一份 yaml 生成 5 份代码

- **源**：`packages/protocol/spec/*.yml`（19 个文件，按 top-level key 合并，重名抛错）。
- **生成**：`utils/generate_channels.js` 一次产出 5 个文件（`:483-487`）：`protocol/src/structs.d.ts`、`client/channels.d.ts`、`server/channels.d.ts`、`isomorphic/protocolMetainfo.ts`、`protocol/src/validator.ts`。
- **生成器自带 CI 守卫**（`:467-488`）：内容没变就不写；**有变化就 `process.exit(1)`** —— 本地和 CI 自动发现"改了 yaml 忘了重新生成"。

运行时按 `type + TitleCase(method) + kind` 查表（`validatorPrimitives.ts:25-34`），`kind ∈ Initializer | Event | Params | Result | ErrorDetails`。例：

```ts
// protocol/src/validator.ts:1332-1346
scheme.FrameClickParams = tObject({
  selector: tString,
  strict: tOptional(tBoolean),
  force: tOptional(tBoolean),
  scroll: tOptional(tEnum(['auto', 'none'])),
  ...
});
```

**为什么不用 CDP 直连**：① CDP 是 Chromium 私有（Firefox 是 juggler、WebKit 是 inspector、BiDi 还在标准化）；② 客户端要支持任意语言；③ 能在消息层做 trace/recorder/slowMo 这类横切；④ **服务端可以按用户语言渲染错误** —— `Root.initialize({ sdkLanguage })` 写进 `browser.options.sdkLanguage`，于是报错里能生成 `get_by_role(...)` / `getByRole(...)` 对应语言的代码（`injectedScript.ts:1335/1347`）。

---

## 5. 驱动抽象：三浏览器 + BiDi

`BrowserType` 只有 5 个 abstract（`server/browserType.ts:358-362`）：`defaultArgs / connectToTransport / amendEnvironment / doRewriteStartupLog / attemptToGracefullyCloseBrowser`。

每家只是换一个 pipe 参数：

| 浏览器 | 参数 | 位置 |
|---|---|---|
| Chromium | `--remote-debugging-pipe` | `chromium.ts:355-364` |
| Firefox | `-juggler-pipe` | `firefox.ts:106` |
| WebKit | `--inspector-pipe` | `webkit.ts:109` |

两条多态边界：

- `Browser`（`browser.ts:73-101`）：建 context / 连接状态 / version / userAgent；
- `PageDelegate`（`page.ts:59-104`）：`rawMouse / rawKeyboard`、`navigateFrame`、`takeScreenshot`、`getContentQuads`、`scrollRectIntoViewIfNeeded`、`rafCountForStablePosition()`、`inputActionEpilogue()`，以及一堆可选钩子。

> **共通层** = Page/Frame 状态机、输入语义、auto-waiting、selector、network 归一化、trace；**私有层** = 坐标/滚动/截图/PDF 这些协议能力不一样的东西。

连浏览器差异都下沉到注入脚本（`server/dom.ts:95-115`）：`stableRafCount`（WebKit Windows 要 >1）、`browserName`、`isUtilityWorld` 都作为参数传给页内脚本。

**BiDi 不是"另一种 CDP 适配"**，而是独立 `BrowserType` 实现：`chromium.ts:73-82` 靠 `channel.startsWith('bidi-')` 选路，`bidiChromium.ts:41-52` 先开 CDP 再包一层（Chrome 不支持 native BiDi），Firefox 直连。**复用了 protocol → dispatcher → server 三层，只替换连接层与 delegate** —— 这就是"不暴露 CDP"的回报。

---

## 6. auto-waiting：Playwright 的灵魂

### 6.1 三个嵌套循环

```
循环 A（frames.ts:1195-1245）：解析元素 + notconnected 重试
  while: performActionPreChecks → selectOnSelectorHandle → 拿到元素
       └ 失败返回 continuePolling；元素被 detach 就 log "element was detached from the DOM, retrying"
循环 B（dom.ts:330-383）：actionability 检查 + 命中测试重试
循环 C（injectedScript.ts:718-766）：页内 rAF 等 stable
```

**退避表按 timeout 裁剪**（`frames.ts:1141-1149`）：

```ts
const backoffScale = [20, 50, 100, 100, 500];
while (backoffScale.length && backoffScale.at(-1) > progress.timeout / 5)
  backoffScale.pop();
```

保证 3 秒超时也能真重试几次，而不是一次睡完。

**等待必须可被打断**（`frames.ts:1156-1165`）：`LongStandingScope.raceMultiple([page.openScope, frame.detachedScope], timer)` —— 页面关闭/帧 detach 立刻抛。

### 6.2 actionability 五项（全在 `packages/injected/src/injectedScript.ts`）

| 项 | 位置 | 要点 |
|---|---|---|
| `visible` | `:797-803` | `!!frameVisible && isElementVisible(element)` —— **父帧不可见则子帧元素不可见** |
| `enabled` | `:805-811` | 用 `getAriaDisabled()`（ARIA 语义），不是只看 HTML disabled 属性 |
| `non-inert` | `:813-819` | `isElementInert()` —— inert 子树不可交互（很多框架漏这个） |
| `editable` | `:821-830` | `!disabled && !readonly`；对不支持 readonly 的元素**直接抛错** |
| `stable` | `:718-766` | 连续 N 帧 `getBoundingClientRect` 完全一致，丢弃 <15ms 的帧（WebKit bug） |

### 6.3 `receives events` 是两步，不是一项

**a) 点击前 `expectHitTarget`**（`:1038-1122`）：从目标元素反推所有 enclosing root（**closed shadow root 也能拿**），从外到内逐层 `elementsFromPoint`，要求每层命中的必须是下一层 host。两个 workaround：`display:contents` 时补最内层、WebKit 的 `elementsFromPoint` 顺序 bug。失败时返回可直接进报错的描述：`<div class=...> from <dialog> subtree`。

**b) 点击中 `setupHitTargetInterceptor`**（`:1154-1222`）：在 `window` capture 阶段拦 pointer/mouse/touch，**只认 `event.isTrusted`**，第一个事件命中点不对就 `preventDefault + stopPropagation + stopImmediatePropagation` 并让后续事件全部失效 —— 解决"发出事件"到"页面处理事件"之间的 layout shift 竞态。

另外还有**滚动策略轮换**（`dom.ts:391-398`）：`undefined → end-end → center-center → start-start`，专门把被 `position:sticky` 头部盖住的元素滚出来。

### 6.4 strict mode

- Locator 默认 `strict: true`，Frame 默认不 strict（`frameSelectors.ts:53-55`）。
- 判定在页内：`frameSelectors.ts:254-259` `if (strict && elements.length > 1) throw strictModeViolationError(...)`。
- **报错本身就是 debugger**（`injectedScript.ts:1324-1348`）：给每个命中元素现场生成 selector，并按用户 SDK 语言渲染：

```
Error: strict mode violation: locator('div') resolved to 2 elements:
    1) <div>a</div> aka getByText('a')
    2) <div>b</div> aka getByText('b')
```

用户复制 `aka` 后面的代码即可精确命中。

### 6.5 超时：`progress.race` 单点打断

`server/progress.ts:135-147`：

```ts
if (deadline) {
  const timeoutError = new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  timer = setTimeout(() => {
    if (this.metadata.pauseStartTime && !this.metadata.pauseEndTime) return;  // 调试暂停不超时
    if (this._state === 'running') {
      this._state = { error: timeoutError };
      this._forceAbortPromise.reject(timeoutError);
      this._controller.abort(timeoutError);
    }
  }, deadline - monotonicTime());
}
```

`race()` 把 `_forceAbortPromise` 一起 race —— **所以任意深度的 await 都被同一个超时打断**，不需要每层传 signal。他们还加了 `PW_DETECT_NESTED_PROGRESS` 自检（`:109-120`）：嵌套 race 会打印告警 + 两段栈，因为这是纪律问题。

---

## 7. 注入脚本：selector / role / aria

### 7.1 三层分工

```
server/selectors.ts（引擎白名单）→ server/frameSelectors.ts（分帧 + strict）
  → injected/injectedScript.ts（1943 行的类，页内执行一切）
```

引擎集合（`injectedScript.ts:216-248`）：`css / xpath / role / text / id / data-test* / nth / visible / internal:{control,has,has-not,and,or,chain,label,text,has-text,has-not-text,attr,testid,role,describe} / aria-ref`。自定义引擎 = 把函数源码字符串 eval 进每个 frame 的 utility world。

### 7.2 `text=` 引擎：四套语义（也最容易踩）

`injectedScript.ts:1799-1838`：

| 写法 | kind | 语义 |
|---|---|---|
| `text=foo` | lax | 归一化空白后**大小写不敏感子串** |
| `text="foo"` | strict | 只看**直接文本节点**全等（`span` 包裹就匹配不到！） |
| `text=/foo/` | regex | 对**未折叠空白**的 full 文本匹配 |
| `internal:text="foo"i` | strict/lax | 可显式控制 |

外加：**完全不看可见性**（唯一过滤 `selectorUtils.ts:59-62` 只跳 script/noscript/style/head）→ `text=Submit` 会命中 `display:none` 的按钮。

### 7.3 `role=button[name="Submit"]` 是怎么算的

1. **role** = explicit > implicit，`none/presentation` 会按冲突规则消解（`roleUtils.ts:270-300`）；implicit 映射是一张 130 行的 lambda 表（`:89-260`），例如：
   ```ts
   'A': e => e.hasAttribute('href') ? 'link' : null,
   'FORM': e => hasExplicitAccessibleName(e) ? 'form' : null,
   'HEADER': e => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : 'banner',
   'IMG': e => (e.getAttribute('alt')==='') && ... ? 'presentation' : 'img',
   ```
2. **accessible name** = accname 1.2 九步，330 行递归（`roleUtils.ts:594-1090`）：`namefromprohibited` → `aria-labelledby`（非空即返回）→ 嵌入式控件（textbox→value）→ `aria-label` → 各标签原生替代 → **name from content** → `title` 兜底。
   **name from content 的准入**（`:577-588`）是理解"为什么 `<button>Submit</button>` 有名字、`<div>Submit</div>` 没有"的关键：
   ```ts
   const alwaysAllowsNameFromContent = ['button','cell','checkbox','columnheader','gridcell','heading',
     'link','menuitem','menuitemcheckbox','menuitemradio','option','radio','row','rowheader','switch','tab',
     'tooltip','treeitem'].includes(role);
   ```
3. **`name=` 匹配语义**（`roleSelectorEngine.ts:165-175`）—— 最易误解处：
   ```ts
   // internal:role assumes that [name="foo"i] also means substring.
   if (internal && !options.nameExact && options.nameOp === '=')
       options.nameOp = '*=';
   ```
   | 写法 | 语义 |
   |---|---|
   | `getByRole('button',{name:'Submit'})` | 大小写**不敏感子串**（"Submit form" 也命中） |
   | `getByRole('button',{name:'Submit',exact:true})` | 全等 + 敏感 |
   | 手写 `role=button[name="Submit"]` | 全等 + 敏感（**没有 internal 改写**） |

---

## 8. aria snapshot：给 LLM 看的页面表示（最被低估的资产）

### 8.1 三种模式

| mode | 配置 | 用途 |
|---|---|---|
| `default` / `codegen` | `{visibility:'aria', refs:'none'}` | 断言、录制 |
| `autoexpect` | `{ariaAndVisible, refs:'none'}` | `toMatchAriaSnapshot` |
| **`ai`** | `{visibility:'ariaOrVisible', refs:'interactable', includeGenericRole:true, renderActive, renderCursorPointer}` | **给 LLM / MCP 用** |

### 8.2 真实样例

断言用（`tests/page/page-aria-snapshot.spec.ts:596-605`）：

```yaml
- group:
  - text: |
      one
      two
  - link "  link     1 ":
    - /url: "#"
```

`ai` 模式（`tests/page/page-aria-snapshot-ai.spec.ts:37-46`）：

```yaml
- generic [active] [ref=e1]:
  - button "One" [ref=e2]
  - button "Two" [ref=e3]
  - button "Three" [ref=e4]
```

iframe 内联（`同文件 :98-110`）：

```yaml
- generic [active] [ref=e1]:
  - iframe [ref=e2]:
    - generic [ref=f1e1]:
      - iframe [ref=f1e2]:
        - generic [ref=f3e1]: Hi, I'm frame
```

MCP 文档给模型看的输出（`docs/src/getting-started-mcp.md:82-91`）：

```yaml
- heading "todos" [level=1]
- textbox "What needs to be done?" [ref=e5]
- listitem:
  - checkbox "Toggle Todo" [ref=e10]
```

### 8.3 为什么这是 agent 场景的"正确解法"

1. **「看」与「动」共用一套 ref**：`[ref=e2]` 由 `getByRef()` 直接消费（`injectedScript.ts:768-774`），**模型不用生成 CSS**；
2. **压缩只改显示、不改可寻址性**：distiller 删节点后，被删节点的 ref 仍能解析（`ariaSnapshotDistiller.ts:30-31` 注释明写）；
3. **`refs:'interactable'` 自动过滤噪音**：只给可见 + 可接收指针事件的元素加 ref，附带 `[cursor=pointer]`/`[active]`，模型不需要懂 CSS；
4. **消歧：名字长度 >900 丢弃**（YAML key 上限 1024）、`convertToBestGuessRegex` 把 UUID/`2mb`/`20s`/`22.3`/两位以上数字自动转正则（**故意不转单数字**）—— 消除 flaky；
5. **iframe 拼接是纯合成**（`server/page.ts:1152-1180`）：`aria-ref=${ref} >> internal:control=enter-frame >> body,frameset` —— 把 frame 位置变成一个可寻址 ref，再用 `enter-frame` 跳过它。全仓库最优雅的小技巧。

### 8.4 distiller 的六个压缩插件

框架是 babel 式 plugin 遍历（`ariaSnapshotDistiller.ts:55-99`）：`enter/exit` 双钩子 + 返回 `'remove' | 'unwrap'` 原地改树。`ai` 模式插件顺序（`:247-263`）：

```
mergeStringChildren → removeNamelessImages → removeRedundantNames
→ inlineTextIntoGeneric → removeNameRepeatingChild → unwrapSingleChildGenerics
```

其中 `removeRedundantNames`（`:179-203`）用 `Set<pendingContentRefs>` 单遍记账，解决"子节点内容已经展示了父节点 name 就冗余"——**不用后序回溯**。

---

## 9. test runner

### 9.1 fixture：显式依赖图 + 单次 `use()` + 反序 teardown

依赖不是声明的，是从**函数第一个参数的解构模式**里正则抠出来的（`common/fixtures.ts:292-307`）：

```ts
const match = text.match(/(?:async)?(?:\s+function)?[^(]*\(([^)]*)/);
if (firstParam[0] !== '{' || firstParam[firstParam.length - 1] !== '}')
  onError({ message: 'First argument must use the object destructuring pattern: ' + firstParam, ... });
```

三色 DFS 建图 + 环检测 + 方向校验（`fixtures.ts:183-248`）：

```ts
if (kScopeOrder.indexOf(registration.scope) > kScopeOrder.indexOf(dep.scope))
    addDependencyError(`${registration.scope} fixture "${registration.name}" cannot depend on a ${dep.scope} fixture ...`);
```

运行期（`worker/fixtureRunner.ts:108-135`）：fixture 函数拿到 `useFunc`，**调第二次直接抛错**，setup/teardown 用两个 ManualPromise 配对；teardown 顺序由依赖图算出的**反序**执行，并且"时间已耗尽"时直接跳过（避免级联超时）。

| 维度 | Jest | Playwright Test |
|---|---|---|
| 依赖声明 | 隐式 + beforeEach 手工串联 | **显式依赖图** + 自动拓扑排序 |
| 作用域 | 全局 / 文件 | `test` / `worker` 两级 + 编译期方向校验 |
| 覆写 | 无标准机制 | `test.use()` 逐层 override + `super` 链 |
| 清理 | 手写 afterEach | `use()` 自动反序 teardown |

### 9.2 并行：`workerHash` 是可计算的内容哈希

`workerHash = project.id + poolDigest + repeatEachIndex`（`common/suiteUtils.ts:78`），test id = `fileId + sha1("[project=x]file␞title…")`（`:36-51`）。**"能不能在同一个进程里跑"从配置问题变成了哈希比较**——这是它并行又快又对的根本。

### 9.3 调度：同步状态机 + 单点异步

`runner/dispatcher.ts:102-140` 注释明写 "keep this method synchronous for easier reasoning"：

```ts
let workerIndex = this._workerSlots.findIndex(w =>
  !w.jobDispatcher && w.worker && w.worker.hash() === job.workerHash && !w.worker.didSendStop());
if (workerIndex === -1) workerIndex = this._workerSlots.findIndex(w => !w.jobDispatcher);
```

- **retry**：`immediate`（默认，与剩余 test 同 job 重跑）/ `isolated`（收集成独立 job + exclusive 锁）；
- **repeat-each**：不是运行时循环，而是**加载期克隆 suite**（`loadUtils.ts:265-280`）；
- **shard**：按 **group** 切分并按"非 skipped 的 test 数"做权重平衡；
- **shuffle**：`sha1(seed + group.tests[0].id)`，同 seed 跨机器可复现。

### 9.4 四套并存的超时（也是最大的坑）

| 类型 | 实现 | 位置 |
|---|---|---|
| test/hook/fixture | **时间槽模型** `{timeout, elapsed}`，可 ×3（`slow()`），可独立分配 | `worker/timeoutManager.ts:124-141` |
| expect | `deadlineForMatcher` 取 `min(expect deadline, testDeadline - 250ms)` | `matchers/matchers.ts:547-559` |
| global | `TimeoutWatcher` 与 taskLoop 赛跑，超时连 cleanup 都不做 | `runner/taskRunner.ts:76-137` |
| `test.step` | `raceAgainstDeadline` 单独包一层 | `testType.ts:287-304` |

时间槽模型的精髓：**"时间已耗尽" 变成"不启动"**（`isTimeExhaustedFor`），避免级联失败；afterEach/afterAll 额外拿 `max(project.timeout, test.timeout)` 的预算。

### 9.5 reporter 与 blob/merge

- 事件序列：`onConfigure → preprocess? → onBegin → [onTestBegin → onStepBegin/End* → onStdOut/Err → onTestEnd]* → onError* → onEnd → onExit`；
- `list` 是 296 行**手写 ANSI 光标控制**（`\u001B[nA` / `[2K[0G`），自己维护 `_lastRow/_lastColumn/ttyWidth`，零依赖；
- **blob + merge = 事件重放**：blob reporter 把事件序列化成 `report.jsonl` 打进 zip，`merge.ts` 用 `TeleReporterReceiver` 把事件**重放**给真正的 reporter —— 分片报告的正确做法（序列化事件，而不是序列化最终文档）；
- **report ↔ trace 只靠 "attachment 名字 + 相对 URL" 解耦**（`html-reporter/src/links.tsx:184-186`）：`trace/index.html?trace=...`。所以 `npx playwright show-trace`、`trace.playwright.dev`、report 三个入口能共存。

### 9.6 trace：每个 action 一张 DOM 快照

**hook 在哪**：不是 test runner，而是 core 的 `Tracing` 作为 `InstrumentationListener` 挂在 context 上，对每次 API 调用三阶段抓（`server/trace/recorder/tracing.ts:577-614`）：`onBeforeCall`（before）→ `onBeforeInputAction`（action）→ `onAfterCall`（after）。抓不抓按 `flags.snapshot` + phase 决定，所以 `click` 有 3 张，`expect` 只有 2 张。

**怎么不膨胀**（关键）：节点级增量引用 —— 内容没变时只写 `[几个快照前, 第几个节点]`：

```ts
// snapshotterInjected.ts:423-433
if (equals) return { equals: true, n: [[snapshotNumber - data.ref![0], data.ref![1]]] };
nodeCounter += extraNodes;
data.ref = [snapshotNumber, nodeCounter++];
```

**怎么回放**：trace viewer 不是"渲染一个 HTML 文件"，而是**起一个 Service Worker 当渲染服务**（`isomorphic/trace/snapshotServer.ts:32-56`），拦截虚拟域名的请求，按当前 `callId + phase` 返回渲染结果，资源来自 HAR / `resourceOverrides`。LRU 缓存 100MB/trace，否则拖时间轴会卡死。

**zip 里有什么**：`test.trace`（runner 自己写的 JSONL：context-options / before / after / error / stdout）+ 浏览器侧 chunk（`trace.trace` / `trace.network` / `resources/` / `src/<sha1>` / 可选 screenshots、aria、screencast）。合并时 `test.trace` 保留原名，同名加 `i-` 前缀。

**`retain-on-failure` 不产生网络开销的关键**：`maybeGenerateNextTraceRecordingPath()`（`worker/testTracing.ts:159-166`）在"test + afterEach 都通过"时返回 `undefined` → 根本不下载 trace。

---

## 10. 工程实践：这个仓库怎么测自己

| 实践 | 说明 |
|---|---|
| **用稳定版 runner 测 ToT runner** | `ttest` 脚本用 `tests/playwright-test/stable-test-runner` 里锁定的稳定版跑，README 直说："It is possible to test broken test runner with a stable working one." |
| **`runInlineTest` 虚构项目** | 测试代码 = 把 `{'a.spec.ts':'...'}` 写进临时目录 → 起子进程跑 CLI → `--reporter=json` 解析回结构化结果 |
| **`--list --forbid-only`** | `utils/lint_tests.js` 用三套 config 各跑一次，防止漏 `.only` |
| **`DEPS.list` + 生成 `DEPS.true` 双向校验** | `build_deps_true.js` 扫真实 import，`validate_deps.js` 反向查"声明但没用"，`check_deps.js` 校验包分层 |
| **生成物入库 + 变了就 exit 1** | protocol / types / docs 全部同源生成 |
| **`lint` 是 9 步流水线** | `eslint + tsc + doc + check-deps + generate_channels + generate_types + lint-tests + test-types + lint-packages` |

---

## 11. ⭐ 可借鉴清单

### A. 如果你在写测试（用 Playwright 的人）

| # | 学什么 | 怎么做 |
|---|---|---|
| 1 | **用 `getByRole` 而不是 CSS** | 它走真实 accessible name 计算（§7.3），对 UI 改版最鲁棒；CSS class 一改名就挂 |
| 2 | **理解 `name` 是子串匹配** | `getByRole('button',{name:'Submit'})` 会命中 "Submit form"；要精确加 `exact:true` |
| 3 | **不要用 `text=Submit` 选可见元素** | 它不看可见性（§7.2），会命中 `display:none` 的按钮 |
| 4 | **`retain-on-failure` + trace 是排障第一入口** | 失败时 `npx playwright show-trace` 能看到每个 action 的 DOM 快照 + 网络 + 源码 |
| 5 | **fixture 比 beforeEach 可靠一个数量级** | worker-scope fixture 跨文件复用；teardown 自动反序 |
| 6 | **别用固定 `waitForTimeout`** | auto-wait 已覆盖 visible/stable/enabled/receives-events，加 sleep 只会让测试更慢更脆 |
| 7 | **`expect(locator)` 是 web-first 断言** | 服务端三段式重试（pre-check → 无超时 one-shot → 退避重试），不需要自己写 poll |

### B. 如果你在写框架 / 平台

| # | 借鉴点 | 价值 |
|---|---|---|
| 1 | **单一 schema → 生成全链路 RPC**（§4） | 一次性投入，之后"本地/远程/多语言"全免费；生成物入库 + exit 1 守卫 |
| 2 | **`progress.race` 单点超时**（§6.5） | 一个 timer 打断任意深度 await；配"嵌套 race 自检" |
| 3 | **对象图 RPC + 三部署只换 transport**（§2） | 本地库/守护进程/远程服务行为一致 |
| 4 | **懒事件订阅**（§3） | 高频事件不订阅就不传，吞吐直接量级提升 |
| 5 | **`workerHash` 决定进程复用**（§9.2） | 并行正确性从"配置纪律"变成"哈希比较" |
| 6 | **时间槽超时**（§9.4） | `{timeout, elapsed}` 可变 + "耗尽则不启动"，避免级联失败 |
| 7 | **错误即协议 + 结构化 details**（§6.4） | 机器读 received/expected，人读压缩 call log，互不干扰 |
| 8 | **观测旁路隔离**（`dispatcher.ts:365-391`） | 埋点用自己的 ProgressController + 3s 上限 + `.catch(()=>{})`：观测挂了不能拖死主流程 |
| 9 | **blob/merge 的事件重放**（§9.5） | 分片报告 = 序列化事件，而不是合并文档 |

### C. 如果你在做 browser agent（和 page-agent / browser-use 对照）

| # | 借鉴点 | 价值 |
|---|---|---|
| 1 | **aria snapshot + ref**（§8） | 「看」和「动」共用一套 ID，模型不用生成 CSS；官方 MCP 就走这条路 |
| 2 | **distiller 的 plugin 遍历框架**（§8.4） | `enter/exit` + `remove/unwrap`，一趟跑完 N 个压缩策略 |
| 3 | **hit target 双校验**（§6.3） | 解决"点了但点到别的元素"——agent 最高频的失败模式 |
| 4 | **stable 判定：两帧 rect 比对 + 丢短帧**（§6.2） | 比 MutationObserver 简单，比 transitionend 鲁棒 |
| 5 | **Builtins 绑定原始实现**（`utilityScript.ts:36-66`） | 页面 fake timer / 改 Date 时，注入脚本的超时逻辑仍然有效 |
| 6 | **`_setupGlobalListenersRemovalDetection`**（`injectedScript.ts:1478-1501`） | document 被整体替换（SPA/`document.write`）后自动重挂监听器 |
| 7 | **selectorGenerator 打分表**（§12） | 分数表本身就是设计文档：testid 1 ≪ role+name 100 ≪ id 500 ≪ tag 530 ≪ nth 10000 ≪ css 1e7 |

---

## 12. 选定组件速览：selectorGenerator（录制用）

打分表（`injected/src/selectorGenerator.ts:37-68`）：

| 候选 | 分数 |
|---|---|
| testid | 1-2 |
| iframe name/title | 10 |
| role + name | 100 |
| placeholder / label / alt | 120 / 140 / 160 |
| text / title / text-regex | 180 / 200 / 250 |
| id | 500 |
| role（无 name） | 510 |
| `input[type]` / tag | 520 / 530 |
| `nth=` | 10000 |
| css 兜底 | 1e7 |

主循环（`:136-200`）三条规则：① **自检**：候选必须真的命中 target；② 已按分数排序，**第一个"唯一命中"即最优**；③ index > 5 就不生成 `nth=6`。还有 `suitableTextAlternatives`（去掉前后动态数字、多长度备选）、`isGuidLike`（用"字符类型跳变次数"判随机 id，不用正则）。

---

## 13. 不要抄的坑

| # | 坑 | 证据 | 正确做法 |
|---|---|---|---|
| 1 | **三份引擎注册表靠注释同步**（server 白名单 / injected 注册 / parser 推断），不一致运行期才 throw | `selectors.ts:36-46`、`injectedScript.ts:216-248`、`selectorParser.ts:42` | 构建期由单一真源生成 |
| 2 | **`text=` 四套语义**：引号种类承载语义、strict 反而比 lax 严 | §7.2 | 一套"归一化子串/全等" + 显式 `exact` 参数 |
| 3 | **`text=` 不看可见性** | `selectorUtils.ts:59-62` | 默认过滤不可见节点 |
| 4 | **手写 `role=` 与 `getByRole` 的 name 语义不同** | `roleSelectorEngine.ts:170-172` | `exact` 显式进语法，别让 internal 与否隐式改算子 |
| 5 | **accessible name 硬编码英文** "Choose File"/"Submit"/"Reset" | `roleUtils.ts:884-920` | 多语言场景自己实现 |
| 6 | **`<div aria-disabled>` 不算 disabled**（只对白名单 role 生效） | `roleUtils.ts:1280-1284` | 先查 role 再判属性，失败时说明原因 |
| 7 | **`toBeEditable()` 在 `<div>` 上抛异常**而非返回 false | `injectedScript.ts:824-825` | 断言统一"不满足→失败，无法判定→抛错" |
| 8 | **strict 报错路径同步生成最多 10 个 selector**，超大 DOM 上报错本身很慢 | `injectedScript.ts:1324-1341` | lazy getter 或只取前 3 个 |
| 9 | **`rect = {x: top, y: left}` 命名交叉错位** | `injectedScript.ts:736` | 注意，不影响功能但极误导 |
| 10 | **`stable` 的 `<15ms` 丢帧在 144Hz 屏幕上会丢光** | `:729-733` | 自适应帧时长 |
| 11 | **`frames.ts` 1936 行 / `page.ts` 1188 行 / `dom.ts` 1073 行上帝类**（Frame 同时管导航、selector、action、expect、截图、aria snapshot），`_retryWithProgressIfNotConnected` 十几参长签名 | — | 学机制，别学组织结构 |
| 12 | **`PageDelegate` 上一堆可选钩子**（`pdf? / coverage? / noUtilityWorld? / cspErrorsAsynchronousForInlineScripts?`）是 bug 驱动的考古层 | `page.ts:95-104` | 等第二个实现出现再抽象 |
| 13 | **`__testHookBeforeStable` / `isUnderTest()` 塞在生产路径** | `dom.ts:431-446` | 用显式 DI 隔离 |
| 14 | **`fn.toString()` 正则解析 fixture 依赖**（注释/箭头函数/默认值都要特判） | `fixtures.ts:292-315` | 用 AST 或显式 `deps: []` |
| 15 | **200+ 行手写 ANSI 光标控制** | `reporters/list.ts:225-267` | 用 `log-update` |
| 16 | **隐式全局 `test()`**（模块级副作用）：一文件 import 另一测试文件就出错，报错文案写了 5 条常见原因 | `globals.ts`、`testType.ts:78-92` | 显式 `describe()` 或导出形式 |
| 17 | **`toPass` 默认 `timeout: 0`（只跑一次）**，看起来像重试 API 却默认不重试 | `matchers/matchers.ts:505` | 默认值选对 |
| 18 | **四套超时机制不同源**（test/expect/global/step） | §9.4 | 一套 deadline 体系 |
| 19 | **`webServer` 优雅关闭依赖进程组信号，Windows 直接不支持** | `webServerPlugin.ts:121-140` | 靠 app 自己的 shutdown endpoint |
| 20 | **trace 快照"best-effort"**：失败只 log 不报错，trace 少了几张快照没有任何信号 | `snapshotter.ts:112-121`、`tracing.ts:513-533` | 加"快照缺失"指标 |
| 21 | **`workerHash` 含 `project.id`，改 project 名 = `--last-failed` 全失效** | `suiteUtils.ts:49-51,78` | 用 config 内容稳定指纹 |

---

## 14. 源码阅读路线（给学习用）

按"投入产出比"排序，只看这 8 个文件就能理解 80%：

| 顺序 | 文件 | 时长 | 收获 |
|---|---|---|---|
| 1 | `packages/protocol/spec/frame.yml` + `utils/generate_channels.js` | 15min | 一份协议如何驱动两端 |
| 2 | `playwright-core/src/client/channelOwner.ts`（Proxy + 懒订阅） | 20min | RPC 客户端设计 |
| 3 | `playwright-core/src/server/progress.ts`（209 行） | 20min | **最值得抄的单文件**：deadline/race/log |
| 4 | `playwright-core/src/server/frames.ts:1141-1245`（三层重试骨架） | 30min | auto-waiting 的骨架 |
| 5 | `injected/src/injectedScript.ts:699-855`（states）+ `1038-1222`（hit target） | 40min | 什么叫"像人一样操作" |
| 6 | `injected/src/roleUtils.ts:577-1090`（accessible name） | 40min | accname 1.2 的实现级理解 |
| 7 | `packages/playwright/src/common/fixtures.ts` + `worker/fixtureRunner.ts` | 30min | fixture 模型 |
| 8 | `playwright-core/src/server/trace/recorder/snapshotterInjected.ts:400-450` | 20min | 增量快照的 10 行核心 |

想进一步：`playwright/src/runner/dispatcher.ts`（同步调度器）、`matchers/matchers.ts`（poll 原语）、`injected/src/selectorGenerator.ts`（打分表）。

---

## 15. 三份报告的横向对照

| 维度 | page-agent | browser-use | Playwright |
|---|---|---|---|
| 定位 | 页面内嵌 GUI agent | Python 浏览器 Agent | 自动化测试/驱动库 |
| 操作页面方式 | 注入 JS + 合成事件 | CDP 直连 | CDP/juggler/inspector + 注入脚本 |
| DOM → 模型 | 自研脱水文本 | CDP 三棵树 + paint_order | **aria snapshot**（ARIA 树 + ref） |
| 定位元素 | `[index]` | `[index]` = backendNodeId | selector 引擎 + ARIA + ref |
| 等待策略 | 固定 sleep + 重试 | 事件总线 wait | **actionability 五项 + 三层退避** |
| 上下文管理 | 无 | compaction + read_state | 无（不是 agent） |
| 可解释性 | 中 | 中 | **最高**（trace + call log + 错误即协议） |

**一句话**：如果说 page-agent 教你"怎么把网页压成 token"、browser-use 教你"长任务怎么不被上下文撑死"，那 **Playwright 教你的是"怎么把一个不可靠的外部系统变成可解释、可等待、可回放的状态机"** —— 这三件事拼起来，就是 2026 年做浏览器 Agent 的完整拼图。

---

## 16. 最终判断

| 维度 | 评价 |
|---|---|
| **架构清晰度** | ★★★★★ 一份协议驱动两端，三部署只换 transport，边界极清晰 |
| **工程质量** | ★★★★☆ 生成物同源 + 依赖边界校验 + 稳定版自举；扣分在上帝类与四套超时 |
| **可借鉴密度** | ★★★★★ 单文件即可抄（progress.ts / fixtures.ts / snapshotterInjected.ts / roleUtils 的 name 表） |
| **学习成本** | 高（29 万行），但路线明确（§14） |
| **对 agent 开发者的独特价值** | **aria snapshot + hit target + stable 判定**这三样，是当前 agent 场景最缺的工程件 |
