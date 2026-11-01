# M0 Spike 报告：closed shadow DOM 元素追溯 & iframe 内 aria-ref

> 任务：T3（Spike A + Spike B）　执行人：pw-arch　日期：2026-11-01
> 仓库：`/Users/zhaowei/Projects/DEMO/rr`　临时脚本：`/tmp/**`（未写入仓库，附录贴全文）
> 全程只读分析 + 本地临时页面，**未修改 `rr/` 下除 `docs/` 外的任何文件，未 git commit**。

## 0. 环境（实测）

```
$ node -v
v26.10.0
$ node -e "console.log(require('/Users/zhaowei/Projects/DEMO/rr/node_modules/playwright/package.json').version)"
1.64.1
```

| 项 | 值 | 来源 |
|---|---|---|
| OS | darwin（macOS, Apple Silicon） | `process.platform`（脚本打印） |
| Node | v26.10.0 | 同上 |
| Playwright | 1.64.1（精确锁定，`rr/package.json`） | `playwright/package.json` |
| Chromium | `156.0.8078.4`（revision `1248`） | `playwright-core/browsers.json` + `browser.version()` 实测 |
| 浏览器缓存 | `~/Library/Caches/ms-playwright/chromium-1248` | 已就绪，未触发下载 |
| 运行方式 | `chromium.launch()` 默认 headless，`viewport: {width:800,height:600}`，`deviceScaleFactor` 默认 1（DPR 测试另开 `deviceScaleFactor:2` 的 context） | 脚本 |

所有命令均在 `cd /Users/zhaowei/Projects/DEMO/rr` 下执行；脚本内部通过绝对路径
`require('/Users/zhaowei/Projects/DEMO/rr/node_modules/playwright')` 解析依赖（脚本放在 `/tmp`，不污染仓库）。

## 0.1 结论速览（TL;DR）

| Spike | 结论 | 关键证据 |
|---|---|---|
| **A. closed shadow 内层元素** | **能拿到**。CDP 可以穿透 `attachShadow({mode:'closed'})` 拿到内层元素的 `backendNodeId` 与稳定属性（`DOM.getNodeForLocation` / `DOM.getDocument({pierce:true})` 均可，且 `closed` 套 `closed` 也行）。**但它不能用于回放**：`backendNodeId` 随文档生命周期失效，且 Playwright locator 完全看不见 closed shadow 内部（`count()===0`）。<br>→ 回放必须走**降级方案：host locator + 相对 host padding box 的 offset**，已实测可精确命中内层按钮。 | `DOM.getNodeForLocation` → `BUTTON id=inner-btn`；`DOM.resolveNode` → `inner-btn\|BUTTON`；`locator('#host').click({position:{x:110,y:80}})` → 内层 button 的 click 监听器 `innerClicks=1` |
| **B. iframe 内 `[ref=f1e2]`** | **能直接用**。`page.getByRef('f1e2')` 可直接定位同源 iframe、**跨域 iframe**、以及嵌套 iframe 内的元素，不需要自己切 frame。<br>但有 3 个硬约束：① ref 只对**该 frame 最近一次 aria snapshot** 有意义（一次 default 模式快照就会让主 frame 的 ref 全部失效）；② 前缀 `f<n>` 在导航/刷新后会变（`e1` → `f2e1` → `f4e1`），旧 ref 抛 `Invalid frame in aria-ref selector`；③ 需要可复用定位器时用 `await page.getByRef(ref).normalize()`，它产出含 `contentFrame()` 链的稳定 Locator 对象，**跨 reload 可复用**（实测 count=1、点击命中）。 | `getByRef('f1e2').count()===1`；`getByRef('f2e2')` 跨域命中；`normalize()` → `locator('iframe[title="Same frame"]').contentFrame().getByTestId('same-btn')` |

**对 M0 的一句话影响**：录制/回放主路径应基于「Playwright 语义 locator + 坐标兜底」，其中
**closed shadow 用 host+offset 兜底**、**AI 兜底用 `getByRef` 并用 `normalize()` 转成持久 locator**；
不要试图把 CDP `backendNodeId` 当作跨步骤身份，也不要把 aria `ref` 当作跨步骤身份。

---

# Spike A：closed shadow DOM 的元素追溯

## A.0 目标与页面

回答：用户点击「`attachShadow({mode:'closed'})` 内部的 button」时，我们能拿到内层元素身份吗？

测试页面（脚本内 http server 动态生成，`/tmp/rr-spike-a2.cjs` 顶部 `PAGE`）：

```html
<my-widget id="host">          <!-- position:absolute; left:100px; top:100px; 300x200;
                                    border:3px solid #333; padding:10px; box-sizing:border-box -->
  #shadow-root (closed 不能从页面 JS 访问)
    <button id="inner-btn" data-testid="inner-btn"
            style="position:absolute;left:50px;top:60px;width:120px;height:40px">Inner</button>
```

Ground truth（测试脚本通过自己保留的 `window.__closedRoot` 引用取得，仅用于对照）：

```
### 0. ground truth (viewport 800x600, dpr=1)
host:  { x: 100, y: 100, w: 300, h: 200 }
inner: { x: 153, y: 163, w: 120, h: 40 }     ← 内层 button 的 client rect
hostBorder: ["3px","3px"]   hostPadding: ["10px","10px"]
### 0.1 内层 button 中心 (CSS px) = (213, 183)
```

## A.1 页面侧 & Playwright 侧：看不到（符合预期）

```
### 1. page JS 视角
{ "elementFromPoint": "host", "elementsFromPoint": ["host","HTML"],
  "hostShadowRoot": null, "nestShadowRoot": null }        ← closed => shadowRoot 为 null

### 2. Playwright locator 能否到达 closed shadow 内部
{ "#inner-btn": 0, "my-widget button": 0, "[data-testid=inner-btn]": 0,
  "#deep-btn": 0, "#host": 1, "#nest": 1 }
```

结论：**closed shadow 内部对页面 JS、对 Playwright selector 引擎都是不可见的**（open shadow 会被
Playwright 的 CSS 引擎穿透，closed 不会）。`elementFromPoint` 的命中目标被 retarget 到 host。

## A.2 CDP 实测：能拿到内层身份（三条独立路径）

连接方式：

```js
const cdp = await context.newCDPSession(page);
await cdp.send('DOM.enable');                 // getNodeForLocation 需要 DOM 域启用
const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
```

### (a) `DOM.getDocument({depth:-1, pierce:true})` —— 能看到 closed shadow 树

```
### 3a. DOM.getDocument({depth:-1,pierce:true})
host  : { nodeName:"MY-WIDGET", nodeId:9, backendNodeId:10, parentId:8,
          shadowRoots:[ { type:"closed", backendNodeId:11 } ], attrs:{ id:"host" } }
inner : { nodeName:"BUTTON", nodeId:11, backendNodeId:12, parentId:10,
          attrs:{ id:"inner-btn", data-testid:"inner-btn", style:"..." } }
嵌套 closed（closed 里再套 closed）: { nodeName:"BUTTON", nodeId:18, backendNodeId:19,
          attrs:{ id:"deep-btn" } }            ← 也拿得到
```

要点：`pierce:true` 会把 `shadowRootType:"closed"` 的 shadow root 也序列化出来，内层节点的
`backendNodeId` / `attributes` 都完整。

### (b) `DOM.getNodeForLocation({x,y})` —— 返回的是**内层 button，不是 host**

```
### 3b. DOM.getNodeForLocation   （x=213, y=183 = 内层按钮中心，CSS px）
inner btn center, includeUserAgentShadowDOM=false -> { backendNodeId:12, nodeName:"BUTTON",
    attrs:{ id:"inner-btn", data-testid:"inner-btn", ... } }
inner btn center, includeUserAgentShadowDOM=true  -> { backendNodeId:12, nodeName:"BUTTON", ... }   ← 与 false 完全一致
nested closed deep btn center                     -> { backendNodeId:19, nodeName:"BUTTON", attrs:{id:"deep-btn"} }
host 右下空白区（未盖住 button）                   -> { backendNodeId:10, nodeName:"MY-WIDGET", attrs:{id:"host"} }
```

要点：
- **`includeUserAgentShadowDOM` 对本场景没有影响**（它控制的是 UA shadow DOM，如 `<input type=date>`
  内部；author closed shadow 无论如何都能被 `getNodeForLocation` 命中）。
- 命中是真实 hit-test：点在 host 空白处返回 host，点在内层 button 上返回 button。

### (c) `DOM.describeNode` / `DOM.resolveNode` / `DOM.getBoxModel`

```
### 3c. DOM.describeNode(host, depth:3, pierce:true)
{ nodeName:"MY-WIDGET",
  shadowRoots:[ { shadowRootType:"closed", backendNodeId:11,
                  children:[ { nodeName:"BUTTON", backendNodeId:12, attrs:{id:"inner-btn",...} } ] } ] }

### 3d. 从 inner button 沿 nodeId.parentId 向上走
[ { nodeId:11, nodeName:"BUTTON", attrs:{id:"inner-btn"} },
  { nodeId:10, nodeName:"#document-fragment", shadowRootType:"closed", backendNodeId:11 } ]
  ← 注意：到这里就断了，closed shadow root 节点**没有 parentId**（见 A.2 坑 1）

### 3e. DOM.resolveNode(inner backendNodeId=12) + Runtime.callFunctionOn
{ nodeName:"BUTTON", id:"inner-btn", testid:"inner-btn", text:"Inner" }   ← 身份可验证、可操作

### 3f. DOM.getBoxModel(inner backendNodeId=12)
{ contentQuad:[161,166, 265,166, 265,200, 161,200], width:120, height:40 }  ← 内层元素几何（CSS px）
```

### 坑（A.2）

1. **closed shadow root 节点没有 `parentId`**：`DOM.describeNode({nodeId: shadowRootNodeId})` 返回值里
   没有 `parentId`/`hostId` 字段（实测）：
   ```
   ### 2./3. describeNode(shadowRoot nodeId=7, depth:0) 原始返回
   { nodeId:7, backendNodeId:8, nodeType:11, nodeName:"#document-fragment",
     childNodeCount:1, shadowRootType:"closed" }      ← 无 parentId
   ```
   → 想建立「内层元素 → host」的反向映射，**不能只靠 parentId 上溯**；必须用
   `host.shadowRoots[0]` 自上而下建映射（或者比较 `DOM.getNodeForLocation` 的命中与 host 的 content quads）。
2. **`nodeId` 是 per-session 的、`backendNodeId` 是 per-document 的**，两者数字会"看着撞车"
   （上面 host 的 `backendNodeId` 是 10，而 shadow root 的 `nodeId` 也是 10 附近），写代码时不要混用。
   需要跨命令传递时优先 `backendNodeId`，必要时用 `DOM.pushNodesByBackendIdsToFrontend({backendNodeIds:[...]})`
   换回当前 session 的 `nodeId`（实测可用，返回 `{ nodeIds:[9] }`）。
3. **`describeNode(host, depth:1, pierce:false)` 也会返回 `shadowRoots`（只有该节点，不含 children）**：
   即"发现自己有 closed shadow root"这一步**不需要 pierce**：
   ```
   ### 4. DOM.describeNode(host, depth:1, pierce:false)
   { nodeName:"MY-WIDGET", nodeId:6, backendNodeId:7, childNodeCount:0,
     shadowRoots:[{ nodeName:"#document-fragment", nodeId:7, backendNodeId:8,
                    shadowRootType:"closed", childNodeCount:1 }] }
   ```
   要拿内部节点才需要 `depth>=2 && pierce:true`。

> 说明：`nodeId` / `backendNodeId` 的具体数值在不同运行中可能不同（取决于页面结构与 session 内创建顺序），
> 本文结论不依赖具体数值，只看"能拿到 / 拿到的是谁 / 生命周期"。

## A.3 CDP 身份能用于回放吗？——不能

`backendNodeId` 绑定**当前 document**。实测 `page.reload()` 后：

```
### C. reload 后用旧 backendNodeId(12) resolveNode
{ "ok": false,
  "error": "cdpSession.send: Protocol error (DOM.resolveNode): Node with given id does not belong to the document" }
### C2. reload 后重新解析同一个 button
{ "newBackendNodeId": 26, "oldBackendNodeId": 12 }
```

结合 A.1（Playwright locator 看不到 closed shadow 内部），结论：

- **`backendNodeId` 不能存进回放脚本**（页面一刷新就废）；
- **也无法把内层元素转成 Playwright locator**（selector 引擎进不去 closed shadow，`count()===0`）。

## A.4 降级方案（已验证）：host locator + padding box 相对 offset

### A.4.1 页面事件里 `offsetX/offsetY` 的参照系

鼠标点击内层按钮中心 `(213,183)` 后，页面捕获到的 click 事件：

```
### 4. page.mouse.click(内层 button 中心) 后页面看到的事件
{ "clicks": [ { "target":"host", "offsetX":110, "offsetY":80,
                "clientX":213, "clientY":183 } ],
  "innerClicks": 1 }                        ← 内层 button 的监听器确实收到了（事件冒泡穿透 shadow 边界）
```

几何换算：

```
host border box      = (100,100) 300x200      border = 3px     padding = 10px
padding box origin   = (100+3, 100+3) = (103,103)
offset = click - paddingBoxOrigin = (213-103, 183-103) = (110, 80)   ← 与事件里的 offsetX/offsetY 完全一致
```

**结论：`offsetX/offsetY` 相对的是 host 的 padding box（border 内侧），不是 border box、也不是 content box。**
（与内层按钮自身的 `position:absolute; left:50px; top:60px` + 半宽高 `60/20` 相加 = `110/80` 吻合。）

### A.4.2 三种回放写法实测

```
### 5.1 page.locator('#host').click({ position: { x:110, y:80 } })
{ clicks:[{ target:"host", offsetX:110, offsetY:80, clientX:213, clientY:183 }], innerClicks:1 }   ✔ 命中内层按钮

### 5.3 page.mouse.click(paddingBoxOrigin + offset) = page.mouse.click(213,183)
{ clicks:[{ target:"host", offsetX:110, offsetY:80, clientX:213, clientY:183 }], innerClicks:1 }   ✔ 命中

### B. 控制组：locator('#host').click({ position: { x:20, y:10 } })（落在 button 矩形之外）
{ clicks:[{ target:"host", offsetX:20, offsetY:10 }], innerClicks:0 }                              ✔ 点偏了就是没命中
```

（附：`page.mouse` 走的是 Playwright 的鼠标事件，`Input.dispatchMouseEvent` 直接发也是一样的结果：

```
### 7. CDP Input.dispatchMouseEvent(mousePressed/mouseReleased, x=213,y=183)
{ clicks:[{ target:"host", offsetX:110, offsetY:80, clientX:213, clientY:183 }], innerClicks:1 }   ✔
```
）

### A.4.3 DPR 处理：CDP 坐标是 **CSS px**，不要乘 dpr

`deviceScaleFactor: 2` 的 context 里，两个方块 `#dprA`（CSS 中心 (60,60)）与 `#dprB`（CSS 中心 (110,110)）：

```
### 6. dpr=2 ground truth (CSS px) = { dpr:2, dprA_CSS:[60,60], dprB_CSS:[110,110], innerBtn_CSS:[213,183] }

6.1 用 dprA 的 CSS 中心 (60,60) 查询      -> { nodeName:"DIV", attrs:{ id:"dprA" } }      ✔ 命中预期元素
6.2 用 (120,120)（把 CSS 坐标 ×2 当 device px）-> { nodeName:"MY-WIDGET", attrs:{id:"host"} }  ✘ 落到别处
6.3 用内层 button 的 CSS 中心 (213,183) 查询 -> { nodeName:"BUTTON", attrs:{id:"inner-btn"} }  ✔
```

结论：`DOM.getNodeForLocation` 的 `x/y` 是 **主 frame viewport 的 CSS 像素**（与
`Element.getBoundingClientRect()` / `Input.dispatchMouseEvent` 同一坐标系），**无需除以/乘以 DPR**。
若需要换算到 device px（如截图像素），再用 `Page.getLayoutMetrics().cssVisualViewport` 与 dpr 自行换算。

## A.5 Spike A 结论

1. **能否用 CDP 拿到 closed shadow 内层元素的 backendNodeId？→ 能**，且有三条路：
   - 已知坐标：`DOM.getNodeForLocation({x,y})`（一步到位，返回内层元素，无需 pierce）；
   - 已知 host：`DOM.getDocument({depth:-1,pierce:true})` 或 `DOM.describeNode({backendNodeId: host, depth:2, pierce:true})`；
   - 需要操作/取属性：`DOM.resolveNode({backendNodeId})` → `Runtime.callFunctionOn`，`DOM.getBoxModel({backendNodeId})` 取几何。
   坑：closed shadow root 节点**没有 parentId**（反向映射要靠 `host.shadowRoots` 自上而下）；`nodeId`/`backendNodeId` 别混用；`includeUserAgentShadowDOM` 对本场景无效。
2. **该身份不能用于回放**：`backendNodeId` 随 document 失效（reload 后 `resolveNode` 报
   `Node with given id does not belong to the document`），且 Playwright selector 引擎进不去 closed shadow。
3. **降级方案成立**：录 `host locator + offset`，回放 `locator(host).click({ position: {x: offsetX, y: offsetY} })`。
   - offset 参照系 = **host 的 padding box**（= 事件 `offsetX/offsetY` 的语义）；
   - 若从 CDP 算：`offset = hitPointClient − (hostBorderBox.x + borderLeftWidth, hostBorderBox.y + borderTopWidth)`；
   - 坐标系 = **CSS px**，与 dpr 无关；
   - 页面移动/resize 时 offset 仍相对 host 有效（比绝对坐标稳）。

## A.6 对实现的影响（具体到 API 调用）

### 录制侧（拿到这次点击的"语义身份 + 兜底坐标"）

```
1. 监听页面 input 事件时（或从 CDP 侧拿坐标后）：
   const hit = await cdp.send('DOM.getNodeForLocation', { x: clientX, y: clientY });   // CSS px, 主 frame 视口坐标
   const desc = await cdp.send('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 });
   // desc.node.nodeName / attributes(id, data-testid, role …)

2. 若要判断"是否落在 closed shadow 内部"：
   const hostDesc = await cdp.send('DOM.describeNode', { nodeId: <host 的 nodeId>, depth: 1, pierce: false });
   const hasClosedShadow = (hostDesc.node.shadowRoots || []).some(s => s.shadowRootType === 'closed');

3. 记录字段建议：
   { kind: 'click', x, y,                       // CSS px，viewport 坐标（用于兜底重放）
     target: { locator: '<page.getByRole/… 生成的 locator>', role, name, testid, tag, id },
     shadow: { closed: true, host: { locator: '<host 的 locator>' }, offset: { x: offsetX, y: offsetY } } }
   // 禁止持久化 backendNodeId（文档级句柄）
```

### 回放侧（优先级从高到低）

```
1. 普通元素：page.getByRole(...)/getByTestId(...).click()（现有主路径，不受本 spike 影响）
2. closed shadow 内元素（检测到 shadow.closed）：
   await page.locator(rec.host.locator).click({ position: { x: rec.offset.x, y: rec.offset.y } });
   // position 语义 = 被点元素 padding box 相对（Playwright 内部 +borderWidth），已验证可命中内层按钮
3. 元素不可见/定位失败兜底：
   await page.mouse.click(box.x + borderLeft + rec.offset.x, box.y + borderTop + rec.offset.y);
   // 或 CDP Input.dispatchMouseEvent（同样用 CSS px）
```

### 不要做

- ❌ 把 `backendNodeId` 写进 flows/录制产物；❌ 依赖 `document.elementFromPoint` 反查内层元素（closed 会被 retarget 到 host）；
- ❌ 期望 aria 快照能列出 closed shadow 内容（实测不可见，见下文"交叉发现"）。

### 未验证 / 待后续 spike 的边界

- **iframe 内的 closed shadow**：本次只测主 frame。`DOM.getNodeForLocation` 返回体里有 `frameId` 字段，
  跨 iframe 时"坐标用哪个 frame 的视口坐标系 / offset 相对谁"需要单独验证（建议 T4 或实现时先用一个 fixture 打样）。
- **closed shadow 内发生导航/组件重渲染**：host 若被替换，offset 语义需重新取值（正常情况下 host 定位失败会走重试）。
- UA shadow DOM（`<input type=date>` 内部 picker）未测，本产品暂不需要。

---

# Spike B：iframe 内的 aria-ref / `page.getByRef`

## B.0 目标与页面

回答：AI 兜底时，aria snapshot 里出现在 iframe 内的 `[ref=f1e2]`，`page.getByRef('f1e2')` 能否直接定位？

测试拓扑（两个端口 → 同源 + 跨域；再加一层嵌套 iframe）：

```
http://127.0.0.1:A/main.html
  ├─ <h1>Main page</h1> <button id="main-btn">Main Button</button> <input aria-label="Main Email">
  ├─ <iframe id="same" title="Same frame"  src="http://127.0.0.1:A/same.html">     ← 同源
  │     └─ <button id="same-btn">Same Inner Button</button> <input aria-label="Same Email">
  │        └─ <iframe id="nested" src="http://127.0.0.1:A/nested.html">             ← 嵌套同源
  │              └─ <button id="nested-btn">Nested Inner Button</button>
  └─ <iframe id="cross" title="Cross frame" src="http://127.0.0.1:B/cross.html">   ← 跨域（端口不同）
        └─ <button id="cross-btn">Cross Inner Button</button>
```

API 签名先确认（1.64.1 公开类型里就有）：

- `page.getByRef(ref: string): Locator` — 文档原文：*"Refs like `[ref=e2]` are reported by
  `page.ariaSnapshot()` when called with the `"ai"` mode, and resolve against the latest snapshot taken in the
  element's frame."*；参数注释：*"Aria ref of the element, for example `e2` or `f1e3`"*
  （`node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/types/types.d.ts:3160-3176`）
- `page.ariaSnapshot({ mode: 'ai' })` — *"When set to `"ai"`, returns a snapshot optimized for AI consumption:
  including element references like `[ref=e2]` and snapshots of `<iframe>`s"*（`types.d.ts:2115-2120`）
- `locator.normalize(): Promise<Locator>` — *"Refs only work for the latest snapshot. Normalize the ref locator
  and convert it to a string to get resilient locator code"*（`types.d.ts:16497-16517`）

实现层面（1.64.1 打包产物 `playwright-core/lib/coreBundle.js`）：
`page.getByRef(ref)` ≡ `page.locator('aria-ref=' + ref)`（:63430-63432）；
查询时 `_jumpToAriaRefFrameIfNeeded` 用正则 `^f(\d+)e\d+$` 取帧序号并**跳到该 seq 的 frame**
（:21949-21962），因此 ref 里的 `f<n>` 是**寻址信息**，locator 建在哪个 frame 上其实无关。

## B.1 ai 快照的形状：`e<n>` = 主 frame，`f<seq>e<n>` = 子 frame

`page.ariaSnapshot({ mode: 'ai' })` 实测输出：

```yaml
- generic [active] [ref=e1]:
  - heading "Main page" [level=1] [ref=e2]
  - button "Main Button" [ref=e3]
  - generic [ref=e4]:
    - text: Email
    - textbox "Main Email" [ref=e5]
  - iframe [ref=e6]:
    - generic [ref=f1e1]:
      - button "Same Inner Button" [ref=f1e2]
      - generic [ref=f1e3]:
        - text: Inner
        - textbox "Same Email" [ref=f1e4]
      - iframe [ref=f1e5]:
        - button "Nested Inner Button" [ref=f3e2]
  - iframe [ref=e7]:
    - button "Cross Inner Button" [ref=f2e2]
```

对比：`page.ariaSnapshot()`（**default 模式**）只给主 frame 的文本，**没有 ref、也不展开 iframe 内容**：

```
- heading "Main page" [level=1]
- button "Main Button"
- text: Email
- textbox "Main Email"
- iframe
- iframe
```

**ref 命名规则（实测 + 源码印证）**：`f<frameSeq>e<n>`，`frameSeq` 是该 frame 的**全局创建序号**
（主 frame = 0，所以主 frame 的 ref 没有前缀；iframe 从 1 起按创建顺序递增），
**不是嵌套深度**——上面 `nested.html` 只嵌 1 层却是 `f3e2`（同源 iframe = f1，跨域 = f2，嵌套 = f3）。
→ **不能从 ref 推断层级**，也不要自己解析前缀去算 frame。

## B.2 `page.getByRef()` 实测：iframe 内 ref 可直接定位（同源 / 跨域 / 嵌套）

```
### 4. page.getByRef(ref) 逐个解析结果（节选）
{ "ref":"e3",   "count":0 }                                  ← 见 B.3：此处已被一次 default 快照污染
{ "ref":"f1e2", "count":1, "bbox":{x:308,y:90,w:127,h:21} }   ← 同源 iframe 内按钮
{ "ref":"f3e2", "count":1, "bbox":{x:318,y:121,w:135,h:21} }  ← 嵌套 iframe 内按钮
{ "ref":"f2e2", "count":1, "bbox":{x:18,y:260,w:127,h:21} }   ← **跨域** iframe 内按钮
```

点击归因（在 4 个 frame 里分别挂 click 监听器，比较点击前后计数）：

```
### 5. getByRef(f*n*e*m*).click() 是否命中对应 frame
[ { ref:"f1e2", clickedFrames:["/same.html"] },
  { ref:"f3e2", clickedFrames:["/nested.html"] },
  { ref:"f2e2", clickedFrames:["/cross.html"] } ]      ← 都精确落在目标 frame
### 5.1 各 frame 的 click 记录
[ { url:"/main.html",   clicks:[] },
  { url:"/same.html",   clicks:["same-btn", ...] },
  { url:"/cross.html",  clicks:["cross-btn"] },
  { url:"/nested.html", clicks:["nested-btn"] } ]
```

**关键点：寻址是全局的**。`f1e2` 不论从哪个 frame 的 locator 发起，都会跳到 seq=1 的 frame 去查：

```
### 6. 在每个 frame 里直接 query aria-ref（节选：把 4 个 frame 都跑一遍，结果一致）
frame /main.html  : aria-ref=f1e2 -> count 1
frame /same.html  : aria-ref=f1e2 -> count 1
frame /cross.html : aria-ref=f1e2 -> count 1
frame /nested.html: aria-ref=f1e2 -> count 1
（而不带前缀的 aria-ref=e2 在任何 frame 里都是 0）
```

帧序号边界行为（`f0`/不存在的序号）：

```
### E. 帧序号探测
{ "ref":"e1",   "count":1, "tag":"BODY" }                 ← 主 frame（seq 0）的 ref 不带前缀
{ "ref":"f0e1", "count":0 }                               ← f0 不报错，只是查不到（主 frame 的 key 无前缀）
{ "ref":"f1e1", "count":1, "tag":"BODY" }                 ← seq 1 = same.html
{ "ref":"f2e1", "error":"locator.count: Invalid frame in aria-ref selector \"aria-ref=f2e1\"" }
{ "ref":"f9e1", "error":"locator.count: Invalid frame in aria-ref selector \"aria-ref=f9e1\"" }
```

## B.3 坑 1（最重要）：ref 只对「该 frame 最近一次 aria snapshot」有意义

`page.getByRef('e2')` 能不能用，取决于**主 frame 最近一次 ariaSnapshot 是不是 ai 模式**。
一次 default 模式快照会把主 frame 的 ref 表换成"没有 ref 的树"，于是主 frame 的 ref 全部失效：

```
### A. 刚取完 ai 快照
refsA = ["e1","e2","e3","e4","f1e2"]
### A.1 立即 getByRef
{ "mainRef":{ref:"e2", count:1, text:"Main page", tag:"H1"},
  "frameRef":{ref:"f1e2", count:1, text:"Same Inner Button", tag:"BUTTON"} }      ✔ 都可用

### B. 取了一次 default 模式快照后（page.ariaSnapshot() 无参数）
{ "defaultSnapshot":"- heading \"Main page\" [level=1]\n- button \"Main Button\"\n- iframe",
  "mainRef":{ref:"e2", count:0},                                                   ✘ 主 frame ref 失效
  "frameRef":{ref:"f1e2", count:1, text:"Same Inner Button"} }                     ✔ iframe ref 不受影响

### C. 重新取 ai 快照后
{ "mainRef":{ref:"e2", count:1}, "frameRef":{ref:"f1e2", count:1} }                ✔ 恢复

### D. locator("body").ariaSnapshot({mode:"ai"}) 之后
{ "mainRef":{ref:"e2", count:1, text:"Main page"} }                                ✔ ai 模式不破坏
```

解释：default 模式不展开 iframe、也不分配 ref → 主 frame 的 `_lastAriaSnapshotForQuery` 被覆盖；
而子 frame 的表没被碰过，所以 iframe 的 ref 仍然有效。**这解释了"为什么 iframe ref 反而更耐用"**。

## B.4 坑 2：导航后前缀会变（`e1` → `f2e1` → `f4e1`），旧 ref 抛错

连续 `page.reload()` 三次，每次取 ai 快照：

```
step     : initial      → reload#1        → reload#2
snapshot : "(body) ref=e1"  → "(body) ref=f2e1"  → "(body) ref=f4e1"
iframe   : ref=f1e2         → ref=f3e2           → ref=f5e2
可解析   : e1 ✔(BODY)       → f2e1 ✔(BODY)        → f4e1 ✔(BODY)
```

即：**主 frame 在导航后也会带 `f<n>` 前缀**（每次 reload 两个 frame 都拿到新的 seq，+2 递增）。
回放时若沿用旧 ref：

```
### 9. ref 生命周期（reload 前/后）
{ innerRef:"f1e1", beforeLife:1, afterResnap:1, afterDomChange:1,
  afterReload:"ERR locator.count: Invalid frame in aria-ref selector \"aria-ref=f1e1\"" }
```

→ 好消息是**旧 ref 会明确报错**（`Invalid frame in aria-ref selector`），不会静默点到别的元素；
坏消息是**任何导航都必须重新快照**，不能缓存 ref 跨页面使用。

## B.5 坑 3：没有最新快照时 `getByRef` 不报错、只是"查不到"

```
### 8. 全新 page 未取快照时 getByRef("e1")
{ "count":0, "click":"ERR locator.click: Timeout 2000ms exceeded." }
```

→ 实现里**必须先确认快照成功、且中间没有别的快照调用**，否则表现为 30s 超时（很容易误判成"元素不存在"）。

## B.6 ref 在同一文档内的稳定性（好消息：不复用、不错位）

在同一文档内连续取快照 + 增删 DOM：

```
### B. 插入新元素前后：ref -> 元素映射
s1: body e1 / h1 e2 / button#main-btn e3 / iframe e4 / (same.html) button f7e2
s2（在 body 最前面插入 <button id="new-btn"> 后）:
    NEW BUTTON -> f6e5（新编号，追加）
    h1 -> f6e2, main-btn -> f6e3, iframe -> f6e4（原有 ref 全部不变）

### C. 删除 #main-btn 并新增 #replacement-btn 后
    replacement-btn -> f6e6，被删的 f6e3 直接消失（**不会把 f6e3 复用给别的元素**）

### D. 同一 ref 在 s1 与 s3 的指向对比
  f6e2: old=H1 "Main page"   now=H1 "Main page"        （同一元素）
  f6e4: old=IFRAME#same      now=IFRAME#same           （同一元素）
  f6e7…: 无复用、无错位
```

→ **同一文档内 ref 语义稳定、编号只增不复用**；真正的风险是**导航**（B.4）和**快照模式混用**（B.3）。

## B.7 最佳实践：`normalize()` 把 ref 变成可持久化的 locator

`await page.getByRef(ref).normalize()` 返回一个**新的 Locator 对象**（不是字符串），`toString()` 得到
"codegen 风格"的 locator 代码，且**自带 `contentFrame()` 链**（跨域也行）：

```
### A. 所有 ref 的 normalize() 代码（节选，含跨域 + 嵌套）
e2    : getByRole('heading', { name: 'Main page' })
e3    : getByTestId('main-btn')
e4    : locator('iframe[title="Same frame"]')
f1e2  : locator('iframe[title="Same frame"]').contentFrame().getByTestId('same-btn')
f3e2  : locator('iframe[title="Same frame"]').contentFrame().locator('#nested')
          .contentFrame().getByTestId('nested-btn')                          ← 两层嵌套也正确拼出链
f2e2  : locator('iframe[title="Cross frame"]').contentFrame().getByTestId('cross-btn')   ← 跨域
```

**关键验证：normalize 出来的 Locator 对象跨 reload 可复用**（这是"AI 用 ref、回放用 locator"的桥）：

```
### B. normalize 得到的 Locator 对象在 reload 后复用
nestedRef: f3e2
code     : locator('iframe[title="Same frame"]').contentFrame().locator('#nested')
             .contentFrame().getByTestId('nested-btn')
count before reload: 1
count after  reload: 1                       ✔ 对象本身可复用
click after  reload: "ok"                    ✔ 点击成功
各 frame click 记录: nested.html -> ["nested-btn"]   ✔ 精确命中原元素
（同时：旧的 ref "f3e2" 在 reload 后抛 Invalid frame in aria-ref selector）
```

注意：`toString()` 是**JS locator 代码**，不能直接喂给 `page.locator()`：

```
### B. page.locator("<normalize 出来的字符串>")
"ERR locator.count: Unexpected token \"locator(\" while parsing css selector
  \"locator('iframe[title=\\\"Same frame\\\"]').contentFrame().locator('body')\". Did you mean to CSS.escape it?"
```

→ 要落库就先存 `normalize()` 的 Locator 对象（内存）/ 存 code 串（展示、或用自己的小解释器还原成
`page.locator(iframe).contentFrame().getByTestId(...)` 调用），**不要**原样塞回 `page.locator()`。

**稳定性前提**：iframe 要有 `title`/`id`/`data-testid`。实测无任何标识属性的 iframe：

```
### B. 无标识 iframe（无 id/title/name/data-testid）内元素
{ frameRef:"f1e2",
  normalized:"locator('iframe').contentFrame().getByRole('button', { name: 'In Frame' })" }
```

`locator('iframe')` 不唯一——页面上有多个无标识 iframe 时会 strict mode violation / 命中错 frame。
→ **实现建议：录制时给 iframe 打标（或用 title/id）是回放稳定性的前置条件。**

## B.8 Spike B 结论

1. **iframe 内 ref 能否直接用 getByRef？→ 能**，同源 / 跨域 / 嵌套 iframe 均可，且 locator 建在哪个 frame
   上无关（`f<seq>` 自带寻址）。写法就是：
   ```js
   const snap = await page.ariaSnapshot({ mode: 'ai' });          // 必须有 ref，必须 ai 模式
   await page.getByRef('f1e2').click();                          // 原样传字符串，不要剥前缀
   ```
2. **三个必须遵守的约束**：
   - ref ≡ "该 frame **最近一次**快照"的句柄：**快照→决策→执行之间不要插入任何 `ariaSnapshot()`**，
     尤其不要用 default 模式（会静默清掉主 frame 的 ref，表现为 count=0 或 30s 超时）；
   - ref **不跨导航**：reload 后前缀会变（`e1`→`f2e1`→`f4e1`），旧 ref 抛 `Invalid frame in aria-ref selector` → 必须重新快照；
   - 不要自己解析/推断 `f<n>`（是全局 frame 序号，非嵌套深度；`f0` 静默 0，`f9` 直接抛错）。
3. **降级方案（按优先级）**：
   1. `await page.getByRef(ref).normalize()` → 拿到带 `contentFrame()` 链的 **Locator 对象**，可跨 reload 复用
      （**推荐作为"AI ref → 可持久化定位器"的转换器**）；
   2. 失败则重新 `ariaSnapshot({mode:'ai'})` 并把新快照喂给 AI 重新选（ref 本来就是短命句柄）；
   3. 若 getByRef 仍不可用（版本/环境差异），用 `normalize()` 得到的 code 串自己构造 Locator，
      或退化为 `frameLocator(iframe).getByRole(...)` 手写；
   4. **不要**用"AI 返回候选序号从快照里 n-th 取"作为主方案：快照文本解析脆弱且 ref 已够用。

## B.9 对实现的影响（具体到 API 调用）

```
// AI 兜底主循环（推荐形态）
const snap = await page.ariaSnapshot({ mode: 'ai' });        // 1. 只在需要时取一次（ai 模式！）
// ... 送 LLM，得到 { ref: 'f1e2', action: 'click' } ...
const loc = page.getByRef(res.ref);                         // 2. 原样使用
await loc.click();                                          //    失败会抛 Invalid frame / Timeout
const durable = await page.getByRef(res.ref).normalize();   // 3. 成功后可转成持久 locator
const code = durable.toString();                            //    'locator(...).contentFrame().getByTestId(...)'
// 4. 落库：{ ref, normalized: code, locatorKind:'ai-ref' }；回放时用 durable/等价构造

// 禁止/避免
// ❌ 两次 set-of-actions 之间调用 page.ariaSnapshot()（default）——会打掉主 frame ref
// ❌ 缓存 ref 跨导航；❌ 把 ref 当稳定 id 存进 flows
// ❌ 用 page.locator(normalizedString) —— 那是 JS 代码不是 selector
```

---

# 交叉发现：closed shadow 内容对 aria 快照 / AI 也完全不可见

同一页面里放 `closed` 与 `open` 两个自定义元素，取 ai 快照：

```yaml
- generic [active] [ref=e1]:
  - heading "Main" [level=1] [ref=e2]
  - button "Open Button" [ref=e5]      ← open shadow 内容可见
  - button "Before" [ref=e6]
  - iframe [ref=e7]:
    - button "In Frame" [ref=f1e2]
```

```
A.1 closed shadow 内容是否出现在快照: { "包含 Closed Button": false, "包含 Open Button": true }
```

→ **closed shadow 内部元素既不进 Playwright locator，也不进 aria snapshot**。这意味着：
AI 兜底**看不见** closed shadow 里的交互目标，只能靠录制期的 CDP 命中信息（Spike A）。
（`<my-widget>` host 本身也未出现在快照里，因为它没有 ARIA 角色/文本；这会进一步让 AI"以为页面上什么东西都没有"。）

---

# 对 M0 实现的建议清单（可执行）

| # | 建议 | 依据 |
|---|---|---|
| 1 | 录制层同时保存 **a)** locator 语义身份（role/name/testid）与 **b)** 坐标（CSS px）+ **c)** closed-shadow 时的 `hostLocator + offset` | A.5 / A.6 |
| 2 | closed shadow 判定：`describeNode(host, depth:1, pierce:false).shadowRoots[].shadowRootType === 'closed'` | A.2 坑 3 |
| 3 | offset 统一取**页面事件的 `offsetX/offsetY`**（语义最明确 = padding box 相对），不要自己二次换算；CDP 侧算的公式见 A.6 | A.4.1 |
| 4 | 回放 closed shadow：`locator(host).click({position:{x,y}})`；不要用绝对坐标优先（viewport 变化会坏） | A.4.2 |
| 5 | 所有 CDP 坐标一律 **CSS px**，不乘 dpr；截图/device 像素换算单独做 | A.4.3 |
| 6 | 绝不在录制产物里持久化 `backendNodeId` | A.3 |
| 7 | AI 兜底：`ariaSnapshot({mode:'ai'})` → `getByRef(ref)` → `normalize()` 存持久 locator | B.7 |
| 8 | AI 兜底的**不变量**：snapshot 与 ref 使用之间不得穿插任何 ariaSnapshot；每次导航后必须重取快照 | B.3 / B.4 |
| 9 | iframe 需有 `title`/`id`/`data-testid`（否则 normalize 出 `locator('iframe')` 不唯一） | B.7 |
| 10 | 把 `Invalid frame in aria-ref selector` / `getByRef` 的 count=0 归入"需要重新快照"的可重试错误，而不是致命错误 | B.4 / B.5 |

---

# 附录 A：最小复现脚本

两个脚本都是自包含的（内置 http server + 临时页面），只需 `cd /Users/zhaowei/Projects/DEMO/rr` 后 `node <脚本>`。

## A.1 `/tmp/rr-spike-a-min.cjs`（Spike A）

实测输出：

```
browser: 156.0.8078.4 node: v26.10.0 platform: darwin
1) page JS: element.shadowRoot = null
1) elementFromPoint = host
2) Playwright locator #inner-btn count = 0
3) getDocument(pierce): host.shadowRoots = [{"type":"closed","backendNodeId":4}]
3) getDocument(pierce): inner BUTTON backendNodeId = 11
4) getNodeForLocation(内层中心) -> BUTTON ["id","inner-btn","style","position:absolute;left:50px;top:60px;width:120px;height:40px"]
5) resolveNode -> identity = inner-btn|BUTTON
6) locator(#host).click({position}) -> [{"target":"host","offsetX":110,"offsetY":80}] innerClicks = 1
```

脚本全文：

```js
// 最小复现：Spike A —— closed shadow DOM 内层元素能否用 CDP 拿到 backendNodeId
// 运行: cd /Users/zhaowei/Projects/DEMO/rr && node /tmp/rr-spike-a-min.cjs
const http = require('http');
const { chromium } = require('/Users/zhaowei/Projects/DEMO/rr/node_modules/playwright');

const PAGE = `<!doctype html><head><style>
my-widget{position:absolute;left:100px;top:100px;width:300px;height:200px;border:3px solid #333;padding:10px;display:block;box-sizing:border-box;background:#eef}
</style></head><body style="margin:0"><my-widget id="host"></my-widget>
<script>
customElements.define('my-widget', class extends HTMLElement { constructor() { super();
  const r = this.attachShadow({ mode: 'closed' });
  r.innerHTML = '<button id="inner-btn" style="position:absolute;left:50px;top:60px;width:120px;height:40px">Inner</button>';
  r.getElementById('inner-btn').addEventListener('click', () => window.__inner = (window.__inner || 0) + 1);
} });
window.__clicks = [];
document.addEventListener('click', e => window.__clicks.push({ target: e.target.id || e.target.nodeName, offsetX: e.offsetX, offsetY: e.offsetY }), true);
</script></body>`;

(async () => {
  const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(PAGE); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  console.log('browser:', browser.version(), 'node:', process.version, 'platform:', process.platform);

  // 内层 button 的真实位置：测试脚本无法从 page JS 拿到（closed），这里按 CSS 计算
  const geom = await page.evaluate(() => {
    const h = document.getElementById('host'), b = h.getBoundingClientRect(), cs = getComputedStyle(h);
    return { x: b.x, y: b.y, borderLeft: parseFloat(cs.borderLeftWidth), borderTop: parseFloat(cs.borderTopWidth) };
  });
  const cx = geom.x + geom.borderLeft + 50 + 60, cy = geom.y + geom.borderTop + 60 + 20;  // padding box + button 偏移 + 半径

  console.log('1) page JS: element.shadowRoot =', await page.evaluate(() => document.getElementById('host').shadowRoot));
  console.log('1) elementFromPoint =', await page.evaluate(p => document.elementFromPoint(p.x, p.y).id || 'no-id', { x: cx, y: cy }).catch(() => 'ERR'));
  console.log('2) Playwright locator #inner-btn count =', await page.locator('#inner-btn').count());

  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const find = (n, p) => { if (p(n)) return n; for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) { const r = find(c, p); if (r) return r; } return null; };
  const hostNode = find(doc.root, n => n.nodeName === 'MY-WIDGET');
  const btnNode = find(doc.root, n => (n.attributes || []).includes('inner-btn'));
  console.log('3) getDocument(pierce): host.shadowRoots =', JSON.stringify(hostNode.shadowRoots.map(s => ({ type: s.shadowRootType, backendNodeId: s.backendNodeId }))));
  console.log('3) getDocument(pierce): inner BUTTON backendNodeId =', btnNode && btnNode.backendNodeId);

  const at = await cdp.send('DOM.getNodeForLocation', { x: cx, y: cy });
  const atDesc = await cdp.send('DOM.describeNode', { backendNodeId: at.backendNodeId });
  console.log('4) getNodeForLocation(内层中心) ->', atDesc.node.nodeName, JSON.stringify(atDesc.node.attributes));

  const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: at.backendNodeId });
  const identity = await cdp.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
    functionDeclaration: 'function(){ return this.id + "|" + this.nodeName; }', returnByValue: true });
  console.log('5) resolveNode -> identity =', identity.result.value);

  // 降级方案：host + padding-box offset
  await page.locator('#host').click({ position: { x: 50 + 60, y: 60 + 20 } });
  console.log('6) locator(#host).click({position}) ->', JSON.stringify(await page.evaluate(() => window.__clicks)),
              'innerClicks =', await page.evaluate(() => window.__inner || 0));

  await browser.close(); srv.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
```

## A.2 `/tmp/rr-spike-b-min.cjs`（Spike B）

实测输出：

```
browser: 156.0.8078.4 playwright: 1.64.1
1) page.ariaSnapshot({mode:"ai"}) =
- generic [active] [ref=e1]:
  - heading "Main" [level=1] [ref=e2]
  - button "Main Button" [ref=e3]
  - iframe [ref=e4]:
    - button "Same Inner Button" [ref=f1e2]
  - iframe [ref=e5]:
    - button "Cross Inner Button" [ref=f2e2]
2) refs = e1,e2,e3,e4,f1e2,e5,f2e2
3) getByRef('e2') count=1 text=Main
3) getByRef('f1e2') count=1 text=Same Inner Button
3) getByRef('f2e2') count=1 text=Cross Inner Button
4) normalize() =
{
  "e2": "getByRole('heading', { name: 'Main' })",
  "f1e2": "locator('iframe[title=\"Same frame\"]').contentFrame().getByTestId('same-btn')",
  "f2e2": "locator('iframe[title=\"Cross frame\"]').contentFrame().getByTestId('cross-btn')"
}
5) 一次 default 快照后: mainRef count = 0 | iframeRef count = 1
6) reload 后 durable Locator count = 1 | 旧 ref count = ERR locator.count: Invalid frame in aria-ref selector "aria-ref=f1e2"
```

脚本全文：

```js
// 最小复现：Spike B —— iframe 内 aria-ref 能否用 page.getByRef() 定位；normalize() 能否转成可复用 locator
// 运行: cd /Users/zhaowei/Projects/DEMO/rr && node /tmp/rr-spike-b-min.cjs
const http = require('http');
const { chromium } = require('/Users/zhaowei/Projects/DEMO/rr/node_modules/playwright');

const MAIN = `<!doctype html><body>
<h1>Main</h1><button id="main-btn" data-testid="main-btn">Main Button</button>
<iframe id="same" src="/same.html" width="360" height="120" title="Same frame"></iframe>
<iframe id="cross" src="__CROSS__" width="360" height="120" title="Cross frame"></iframe></body>`;
const SAME = `<!doctype html><body><button id="same-btn" data-testid="same-btn">Same Inner Button</button></body>`;
const CROSS = `<!doctype html><body><button id="cross-btn" data-testid="cross-btn">Cross Inner Button</button></body>`;

const refs = s => [...s.matchAll(/\[ref=([a-z0-9]+)\]/gi)].map(m => m[1]);

(async () => {
  const srvB = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(CROSS); });
  await new Promise(r => srvB.listen(0, '127.0.0.1', r));
  const srvA = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end(q.url === '/same.html' ? SAME : MAIN.replace('__CROSS__', `http://127.0.0.1:${srvB.address().port}/cross.html`));
  });
  await new Promise(r => srvA.listen(0, '127.0.0.1', r));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${srvA.address().port}/main.html`);
  await page.waitForLoadState('load');
  console.log('browser:', browser.version(), 'playwright: 1.64.1');

  const snap = await page.ariaSnapshot({ mode: 'ai' });
  console.log('1) page.ariaSnapshot({mode:"ai"}) =\n' + snap);
  const all = refs(snap);
  const mainRef = all.find(r => /^e\d+$/.test(r) && r !== 'e1');
  const iframeRefs = all.filter(r => /^f\d+e\d+$/.test(r));
  console.log('2) refs =', all.join(','));

  for (const r of [mainRef, ...iframeRefs]) {
    const loc = page.getByRef(r);
    console.log(`3) getByRef('${r}') count=${await loc.count()} text=${(await loc.evaluate(e => e.textContent || '')).trim()}`);
  }

  // normalize(): ref -> 稳定 locator 代码（含 contentFrame() 链）
  const norm = {};
  for (const r of [mainRef, ...iframeRefs]) norm[r] = (await page.getByRef(r).normalize()).toString();
  console.log('4) normalize() =\n' + JSON.stringify(norm, null, 2));

  // default 模式快照会清掉「主 frame」的 ref 表（iframe 的 ref 不受影响）
  await page.ariaSnapshot();                       // mode 默认 = default，无 ref
  console.log('5) 一次 default 快照后: mainRef count =', await page.getByRef(mainRef).count(),
              '| iframeRef count =', await page.getByRef(iframeRefs[0]).count());

  // normalize 出来的 Locator 对象可跨导航复用
  await page.ariaSnapshot({ mode: 'ai' });
  const durable = await page.getByRef(iframeRefs[0]).normalize();
  await page.reload(); await page.waitForLoadState('load');
  console.log('6) reload 后 durable Locator count =', await durable.count(),
              '| 旧 ref count =', await page.getByRef(iframeRefs[0]).count().catch(e => 'ERR ' + e.message.split('\n')[0]));

  await browser.close(); srvA.close(); srvB.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
```

---

# 附录 B：本次全部探针脚本（均在 `/tmp`，可直接复跑）

| 脚本 | 用途 | 关键覆盖 |
|---|---|---|
| `/tmp/rr-spike-a2.cjs` | Spike A 主探针 | getDocument pierce / getNodeForLocation / describeNode / resolveNode / getBoxModel / 嵌套 closed shadow / 点击事件 offset / 降级方案三种写法 / DPR=2 / CDP Input 回放 |
| `/tmp/rr-spike-a3.cjs` | Spike A 补充 | nodeId 图链路、offset 命中控制组、backendNodeId reload 失效 |
| `/tmp/rr-spike-a4.cjs` | Spike A 补充 | shadow root 节点无 parentId、pierce 开关差异、`pushNodesByBackendIdsToFrontend` |
| `/tmp/rr-spike-b.cjs` | Spike B 主探针 | 同源/跨域/嵌套 iframe、ai vs default 快照、getByRef 全量解析、点击归因、frame 内 query、ref 生命周期 |
| `/tmp/rr-spike-b2.cjs` | Spike B 补充 | ref 表被 default 快照覆盖、帧序号探测（f0/f1/f2/f9） |
| `/tmp/rr-spike-b3.cjs` | Spike B 补充 | 前缀随 reload 变化、ref 稳定/不复用、删除后 ref 消失 |
| `/tmp/rr-spike-b4.cjs` | Spike B 补充 | `normalize()` 代码生成（同源/跨域）、`page.locator(code)` 不可用 |
| `/tmp/rr-spike-b5.cjs` | Spike B 补充 | normalize Locator 跨 reload 复用、嵌套 iframe 的链式代码、无 title iframe |
| `/tmp/rr-spike-b6.cjs` | A×B 交叉 | closed vs open shadow 在 aria 快照中的可见性、无标识 iframe 的 normalize 结果 |
| `/tmp/rr-spike-a-min.cjs` | 最小复现 A | 附录 A.1 |
| `/tmp/rr-spike-b-min.cjs` | 最小复现 B | 附录 A.2 |

原始输出文件：`/tmp/spike-a2.out`、`/tmp/spike-a3.out`、`/tmp/spike-a4.out`、`/tmp/spike-b.out`、
`/tmp/spike-b2.out`、`/tmp/spike-b3.out`、`/tmp/spike-b4.out`、`/tmp/spike-b5.out`、`/tmp/spike-b6.out`、
`/tmp/spike-a-min.out`、`/tmp/spike-b-min.out`。
