/**
 * rr capture —— 注入到每个 frame（含 OOPIF）的事件采集脚本。
 *
 * 三条硬约束（为什么这么写）：
 * 1. **零依赖、纯 JS**：用 `context.addInitScript({ path })` 注入，不能走打包，
 *    所以不能 import，也不能用 TS 语法。
 * 2. **只采事实，不做语义判断**：这里不算 role / accessible name / 候选选择器，
 *    只把 tag / 属性白名单 / 文本 / rect / nodePath / 邻近文本交给 Node 侧。
 *    否则「页面内算法」和「Playwright locator」两套语义会漂移。
 * 3. **永不采集敏感值**：`<input type=password>` 只回 `masked: true`，value 恒为 undefined。
 *
 * 与 Node 侧的通道：
 *   - push：`window.__rrEmit(payload)`（由 `context.exposeBinding` 提供）
 *   - pull：`window.__rrFacts(el)` / `window.__rrSnapshot(opts)` / `window.__rrClearUids()`
 *
 * 元素寻址：采集时给目标元素打 `data-rr-uid` 临时标记，Node 侧用 `[data-rr-uid=...]`
 * 把它找回来看候选是否 `count()===1 && visible`；处理完调用 `__rrClearUids()` 清掉。
 */
/* global window, document, location, setTimeout, clearTimeout */
;(function () {
	'use strict'

	// 用 **document** 做安装标记，不能用 window：
	// window 在跨文档导航（window.open 到同源页、同源链接跳转）之后仍然存活，
	// 而 document 会被换掉；只用 window 标记会让「新文档一个监听器都没有」→ 整页录不到事件。
	if (document.__rrCaptureInstalled) return
	document.__rrCaptureInstalled = true

	/** 每个 document 一份随机前缀：导航后计数器重置也不会与旧 document 的 uid 撞车 */
	var DOC_ID = Math.random().toString(36).slice(2, 7)
	var uidSeq = 0

	/** 属性白名单：既要不漏关键语义，也要避免把整页 class/style 搬进 IR */
	var ATTR_WHITELIST = {
		id: 1,
		name: 1,
		type: 1,
		role: 1,
		placeholder: 1,
		title: 1,
		alt: 1,
		for: 1,
		href: 1,
		autocomplete: 1,
		inputmode: 1,
		contenteditable: 1,
		readonly: 1,
		disabled: 1,
		checked: 1,
		multiple: 1,
		accept: 1,
		maxlength: 1,
		pattern: 1,
		'aria-label': 1,
		'aria-labelledby': 1,
		'aria-describedby': 1,
		'aria-live': 1,
		'aria-haspopup': 1,
		'aria-expanded': 1,
	}
	/** 这些属性值可能是动态的，但仍是「事实」，照采；指纹阶段再筛 */
	var MAX_ATTR_LEN = 200
	var MAX_TEXT_LEN = 200

	/* ---------------------------------------------------------------- */
	/* 通道                                                              */
	/* ---------------------------------------------------------------- */

	var outbox = []
	var flushTimer = null

	function scheduleFlush() {
		if (flushTimer) return
		flushTimer = setTimeout(function () {
			flushTimer = null
			if (typeof window.__rrEmit !== 'function') {
				scheduleFlush()
				return
			}
			var items = outbox.splice(0, outbox.length)
			for (var i = 0; i < items.length; i++) push(items[i])
		}, 50)
	}

	function push(payload) {
		try {
			var ret = window.__rrEmit(payload)
			if (ret && typeof ret.catch === 'function') ret.catch(function () {})
		} catch {
			/* binding 尚未就绪，忽略（由 scheduleFlush 重试） */
		}
	}

	function emit(payload) {
		if (typeof window.__rrEmit === 'function') {
			push(payload)
			return
		}
		if (outbox.length > 2000) outbox.shift()
		outbox.push(payload)
		scheduleFlush()
	}

	/* ---------------------------------------------------------------- */
	/* 事实采集（纯函数，Node 侧也复用）                                   */
	/* ---------------------------------------------------------------- */

	function normalize(text) {
		return String(text == null ? '' : text)
			.replace(/[\s\u00a0]+/g, ' ')
			.trim()
	}

	function round(n) {
		return Math.round(n * 100) / 100
	}

	function clip(text, max) {
		var s = normalize(text)
		return s.length > max ? s.slice(0, max) : s
	}

	/** 属性白名单；data-* / aria-* 前缀属性也收（含 data-testid） */
	function readAttributes(el) {
		var out = {}
		var attrs = el.attributes || []
		for (var i = 0; i < attrs.length; i++) {
			var name = attrs[i].name
			if (name === 'class' || name === 'style' || name === 'data-rr-uid') continue
			var keep =
				ATTR_WHITELIST[name] === 1 ||
				name.indexOf('aria-') === 0 ||
				name.indexOf('data-') === 0
			if (!keep) continue
			var value = attrs[i].value
			if (typeof value !== 'string') continue
			out[name] = value.length > MAX_ATTR_LEN ? value.slice(0, MAX_ATTR_LEN) : value
		}
		return out
	}

	/** 元素可见文本：表单控件取可读值，其余取 textContent（password 永不取值） */
	function readText(el) {
		var tag = el.nodeName
		try {
			if (tag === 'INPUT') {
				var type = (el.type || '').toLowerCase()
				if (type === 'password') return undefined
				if (type === 'submit' || type === 'button' || type === 'reset') return clip(el.value, MAX_TEXT_LEN)
				if (type === 'image') return clip(el.alt, MAX_TEXT_LEN)
				return undefined
			}
			if (tag === 'TEXTAREA') return undefined
			if (tag === 'SELECT') {
				var opt = el.selectedOptions && el.selectedOptions[0]
				return opt ? clip(opt.textContent, MAX_TEXT_LEN) : undefined
			}
		} catch {
			/* 访问受限元素属性时忽略 */
		}
		var text = el.textContent
		var clipped = clip(text, MAX_TEXT_LEN)
		return clipped || undefined
	}

	/** documentElement 到元素的 children 索引链（最后手段寻址 + xpath 候选） */
	function nodePathOf(el) {
		var path = []
		var node = el
		var guard = 0
		while (node && node.parentElement && node !== document.documentElement && guard++ < 64) {
			var parent = node.parentElement
			var index = 0
			var cur = parent.firstElementChild
			while (cur && cur !== node) {
				index++
				cur = cur.nextElementSibling
			}
			path.unshift(index)
			node = parent
		}
		return path
	}

	/** 关联标签文本：原生 .labels + aria-label + aria-labelledby */
	function labelsOf(el) {
		var out = []
		try {
			if (el.labels && el.labels.length) {
				for (var i = 0; i < el.labels.length && out.length < 3; i++) {
					var t = clip(el.labels[i].textContent, 80)
					if (t) out.push(t)
				}
			}
		} catch {
			/* 部分元素没有 labels */
		}
		var ariaLabel = el.getAttribute && el.getAttribute('aria-label')
		if (ariaLabel && normalize(ariaLabel)) out.push(clip(ariaLabel, 80))
		var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby')
		if (labelledBy) {
			var parts = labelledBy.split(/\s+/)
			for (var j = 0; j < parts.length && out.length < 4; j++) {
				if (!parts[j]) continue
				var ref = document.getElementById(parts[j])
				if (ref) {
					var refText = clip(ref.textContent, 80)
					if (refText) out.push(refText)
				}
			}
		}
		return dedupe(out)
	}

	/** 邻近文本锚点：左邻 / 上邻 / 父容器自有文本（给 AI 或人工看的弱锚点） */
	function nearbyTextOf(el) {
		var out = []
		function pushText(text) {
			var t = clip(text, 80)
			if (t && out.indexOf(t) === -1 && out.length < 4) out.push(t)
		}
		try {
			var prev = el.previousElementSibling
			if (prev) pushText(prev.textContent)
			var parent = el.parentElement
			if (parent) {
				var own = ''
				for (var i = 0; i < parent.childNodes.length; i++) {
					var child = parent.childNodes[i]
					if (child.nodeType === 3) own += child.nodeValue || ''
				}
				pushText(own)
				var label = parent.getAttribute && parent.getAttribute('aria-label')
				if (label) pushText(label)
			}
			var next = el.nextElementSibling
			if (next) pushText(next.textContent)
		} catch {
			/* 忽略 */
		}
		return out
	}

	function dedupe(list) {
		var out = []
		for (var i = 0; i < list.length; i++) {
			if (list[i] && out.indexOf(list[i]) === -1) out.push(list[i])
		}
		return out
	}

	/**
	 * 采集一个元素的全部事实。**注意：先采属性再打 uid 标记**，避免 uid 污染 attributes。
	 * @param {Element} el
	 * @returns {object|null}
	 */
	function collectFacts(el) {
		if (!el || el.nodeType !== 1) return null
		var rect
		try {
			rect = el.getBoundingClientRect()
		} catch {
			return null
		}
		var className = ''
		try {
			className = typeof el.className === 'string' ? el.className : ''
			if (className.length > 200) className = className.slice(0, 200)
		} catch {
			className = ''
		}
		var facts = {
			tag: el.nodeName.toLowerCase(),
			className: className,
			attributes: readAttributes(el),
			text: readText(el),
			rect: {
				x: round(rect.left),
				y: round(rect.top),
				width: round(rect.width),
				height: round(rect.height),
			},
			scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
			viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
			dpr: window.devicePixelRatio || 1,
			recordedAt: Date.now(),
			labels: labelsOf(el),
			nearbyText: nearbyTextOf(el),
			nodePath: nodePathOf(el),
		}
		return facts
	}

	function markUid(el) {
		try {
			var existing = el.getAttribute('data-rr-uid')
			if (existing) return existing
			var uid = DOC_ID + '_' + ++uidSeq
			el.setAttribute('data-rr-uid', uid)
			return uid
		} catch {
			return undefined
		}
	}

	/**
	 * 事件真正的目标元素。
	 *
	 * `event.target` 在 shadow DOM 边界会被 retarget 成 host（open / closed 都一样）。
	 * 但 `composedPath()[0]` 对 **open** shadow 会给到内层元素，对 **closed** shadow 会被
	 * 规范裁剪掉内层节点（只剩 host）——这正好是我们想要的行为：
	 * - open shadow：录内层元素（Playwright 能穿透 open shadow，回放直接命中）；
	 * - closed shadow：录 host（Spike A：内层对页面 JS / locator / aria 全都不可见）。
	 */
	function eventTargetOf(event) {
		try {
			var path = typeof event.composedPath === 'function' ? event.composedPath() : null
			if (path && path.length && path[0] && path[0].nodeType === 1) return path[0]
		} catch {
			/* composedPath 不可用就退回 target */
		}
		return event.target
	}

	/** 把「事件目标」归一到用户真正想操作的元素（与 Playwright 的 retarget 对齐） */
	var INTERACTIVE =
		'a,button,input,select,textarea,label,summary,option,' +
		'[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],' +
		'[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],' +
		'[role=searchbox],[aria-haspopup],[aria-expanded]'

	function retarget(el) {
		if (!el || el.nodeType !== 1) return el
		var hit = null
		try {
			hit = el.closest ? el.closest(INTERACTIVE) : null
		} catch {
			hit = null
		}
		if (!hit) return el
		if (hit.nodeName === 'LABEL' && hit.control) return hit.control
		return hit
	}

	/**
	 * 点击点相对元素 **padding box** 的 CSS px 偏移。
	 *
	 * 为什么不用 event.offsetX：closed shadow 里事件被 retarget 到 host 时 offsetX 的参照系
	 * 是那个"真实目标"（内层元素），不是 host；而回放要的是 host 的 position。
	 * 所以统一用 clientX/Y 减 host border box 原点与 border 宽度推出来 —— 等价于「若事件直接
	 * 落在 host 上时的 offsetX/Y」，并且**永远是 CSS px，不乘 dpr**（Spike A.4.3）。
	 */
	function offsetWithinPaddingBox(el, event) {
		try {
			var rect = el.getBoundingClientRect()
			var style = el.ownerDocument.defaultView.getComputedStyle(el)
			var borderLeft = parseFloat(style.borderLeftWidth) || 0
			var borderTop = parseFloat(style.borderTopWidth) || 0
			return {
				x: Math.round((event.clientX - rect.left - borderLeft) * 100) / 100,
				y: Math.round((event.clientY - rect.top - borderTop) * 100) / 100,
			}
		} catch {
			return undefined
		}
	}

	function modifiersOf(event) {
		var mods = []
		if (event.altKey) mods.push('Alt')
		if (event.ctrlKey) mods.push('Control')
		if (event.metaKey) mods.push('Meta')
		if (event.shiftKey) mods.push('Shift')
		return mods
	}

	/**
	 * 组装一个事件 payload。
	 * @param {string} kind
	 * @param {Element|null} el
	 * @param {object} data
	 * @param {boolean} trusted
	 */
	function send(kind, el, data, trusted, ts) {
		var facts = el ? collectFacts(el) : null
		if (facts && el) facts.uid = markUid(el)
		emit({
			kind: kind,
			ts: typeof ts === 'number' ? ts : Date.now(),
			frameUrl: location.href,
			facts: facts,
			data: data || {},
			trusted: trusted !== false,
		})
	}

	/** 表单控件的当前值（password 只回 masked 标记） */
	function readValue(el) {
		try {
			var tag = el.nodeName
			if (tag === 'INPUT') {
				var type = (el.type || '').toLowerCase()
				if (type === 'password') return { value: undefined, masked: true }
				if (type === 'checkbox' || type === 'radio') return { checked: !!el.checked }
				if (type === 'file') return { inputType: 'file' }
				return { value: el.value }
			}
			if (tag === 'TEXTAREA') return { value: el.value }
			if (tag === 'SELECT') {
				var values = []
				for (var i = 0; i < el.selectedOptions.length; i++) values.push(el.selectedOptions[i].value)
				return { selectedValues: values, value: values[0] }
			}
			if (el.isContentEditable) return { value: el.textContent || '' }
		} catch {
			/* 忽略 */
		}
		return {}
	}

	/* ---------------------------------------------------------------- */
	/* 事件监听                                                          */
	/* ---------------------------------------------------------------- */

	/** 页面脚本 dispatch 出来的合成事件一律不当用户操作（input/change 例外，见 types.ts） */
	document.addEventListener(
		'pointerdown',
		function (event) {
			if (!event.isTrusted) return
			send('pointerdown', retarget(eventTargetOf(event)), { button: event.button, modifiers: modifiersOf(event) }, true)
		},
		true,
	)

	document.addEventListener(
		'click',
		function (event) {
			if (!event.isTrusted) return
			// 中键走 auxclick，右键走 contextmenu，这里只管左键
			if (event.button !== 0) return
			var target = retarget(eventTargetOf(event))
			send('click', target, { button: 0, modifiers: modifiersOf(event), offset: offsetWithinPaddingBox(target, event) }, true)
		},
		true,
	)

	document.addEventListener(
		'auxclick',
		function (event) {
			if (!event.isTrusted) return
			if (event.button !== 1) return
			var target = retarget(eventTargetOf(event))
			send('click', target, { button: 1, modifiers: modifiersOf(event), offset: offsetWithinPaddingBox(target, event) }, true)
		},
		true,
	)

	document.addEventListener(
		'contextmenu',
		function (event) {
			if (!event.isTrusted) return
			var target = retarget(eventTargetOf(event))
			send('contextmenu', target, { button: 2, modifiers: modifiersOf(event), offset: offsetWithinPaddingBox(target, event) }, true)
		},
		true,
	)

	document.addEventListener(
		'keydown',
		function (event) {
			if (!event.isTrusted) return
			if (event.isComposing) return
			var printable =
				typeof event.key === 'string' &&
				event.key.length === 1 &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey
			send(
				'keydown',
				retarget(eventTargetOf(event)),
				{
					key: event.key,
					code: event.code,
					modifiers: modifiersOf(event),
					isPrintable: printable,
					repeat: !!event.repeat,
				},
				true,
			)
		},
		true,
	)

	document.addEventListener(
		'input',
		function (event) {
			var el = event.target
			if (!el || el.nodeType !== 1) return
			var data = readValue(el)
			data.inputType = el.type || (el.isContentEditable ? 'contenteditable' : undefined)
			// input 允许 untrusted：Playwright 的 fill() 就是 JS 赋值 + dispatchEvent
			send('input', el, data, event.isTrusted)
		},
		true,
	)

	document.addEventListener(
		'change',
		function (event) {
			var el = event.target
			if (!el || el.nodeType !== 1) return
			var data = readValue(el)
			data.inputType = el.type || undefined
			send('change', el, data, event.isTrusted)
		},
		true,
	)

	/*
	 * hover：鼠标在某元素上停留 ≥350ms 且没移出 → 上报一次（带 facts）。
	 *
	 * 为什么在页面内做停留判定：mouseover 是高频事件（一次移动几十个），
	 * 全量回传会把录制通道打爆；而且「停留」本质是计时，必须在页面内用同一个时钟判。
	 * 意义过滤（aria-haspopup / 后面 2s 内有 click）放在 Node 侧做（合流层，可单测）。
	 */
	var HOVER_DWELL_MS = 350
	var HOVER_REEMIT_MS = 1500
	var hoverTimer = null
	var hoverElement = null
	var hoverStamps = typeof WeakMap === 'function' ? new WeakMap() : null

	function cancelHoverDwell() {
		if (hoverTimer) {
			clearTimeout(hoverTimer)
			hoverTimer = null
		}
		hoverElement = null
	}

	document.addEventListener(
		'mouseover',
		function (event) {
			if (!event.isTrusted) return
			var el = retarget(eventTargetOf(event))
			if (!el || el.nodeType !== 1) return
			if (el === hoverElement) return
			cancelHoverDwell()
			hoverElement = el
			hoverTimer = setTimeout(function () {
				hoverTimer = null
				if (hoverElement !== el) return
				var now = Date.now()
				var prev = hoverStamps ? hoverStamps.get(el) : undefined
				if (prev && now - prev < HOVER_REEMIT_MS) return
				if (hoverStamps) hoverStamps.set(el, now)
				send('hover', el, { dwellMs: HOVER_DWELL_MS }, true)
			}, HOVER_DWELL_MS)
		},
		true,
	)

	document.addEventListener(
		'mouseout',
		function (event) {
			if (!event.isTrusted) return
			// 移到自己的子元素上不算「移出」（鼠标还在这个元素范围内）
			var to = event.relatedTarget
			if (hoverElement && to && hoverElement.contains && hoverElement.contains(to)) return
			cancelHoverDwell()
		},
		true,
	)

	// 按下鼠标说明用户不是在「悬停等待」，取消待发的 hover
	document.addEventListener('mousedown', cancelHoverDwell, true)

	/* 滚动：页面内先累加，80ms 合并一次，减少回传量 */
	var scrollState = typeof WeakMap === 'function' ? new WeakMap() : null
	var pendingScroll = null

	function flushScroll() {
		if (!pendingScroll) return
		var payload = pendingScroll
		pendingScroll = null
		// 用「第一段滚动发生的时间」而不是 flush 时间：否则滚动会被记到后面动作之后，
		// 「点击前的自动滚动」过滤逻辑就失效了。
		send('scroll', payload.el, { dx: payload.dx, dy: payload.dy }, payload.trusted, payload.ts)
	}

	document.addEventListener(
		'scroll',
		function (event) {
			var target = event.target
			var el = target === document || target === document.documentElement ? null : target
			var x = 0
			var y = 0
			try {
				if (el) {
					x = el.scrollLeft
					y = el.scrollTop
				} else {
					x = window.scrollX || 0
					y = window.scrollY || 0
				}
			} catch {
				return
			}
			var key = el || document
			var prev = (scrollState && scrollState.get(key)) || { x: 0, y: 0 }
			var dx = x - prev.x
			var dy = y - prev.y
			if (scrollState) scrollState.set(key, { x: x, y: y })
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
			if (pendingScroll && pendingScroll.el === el) {
				pendingScroll.dx += dx
				pendingScroll.dy += dy
				return
			}
			if (pendingScroll) flushScroll()
			pendingScroll = { el: el, dx: dx, dy: dy, trusted: event.isTrusted, ts: Date.now() }
			setTimeout(flushScroll, 80)
		},
		{ capture: true, passive: true },
	)

	/* ---------------------------------------------------------------- */
	/* Node 侧 pull API                                                  */
	/* ---------------------------------------------------------------- */

	window.__rrFacts = function (el) {
		return collectFacts(el)
	}

	/**
	 * 页面签名：只回「可见 + 有意义」的节点，用于 expect 推断（urlChange / elementVisible）。
	 * 每个节点带 uid，Node 侧据此把「新出现的元素」变回 ElementRef。
	 */
	window.__rrSnapshot = function (opts) {
		opts = opts || {}
		var max = typeof opts.max === 'number' ? opts.max : 120
		var nodes = []
		var selector =
			'a,button,input,select,textarea,label,summary,option,img,' +
			'h1,h2,h3,h4,h5,h6,li,p,td,th,dialog,output,progress,meter,[role],[data-testid],[aria-live]'
		var all
		try {
			all = document.querySelectorAll(selector)
		} catch {
			return { url: location.href, nodes: nodes }
		}
		for (var i = 0; i < all.length && nodes.length < max; i++) {
			var el = all[i]
			var rect
			try {
				rect = el.getBoundingClientRect()
			} catch {
				continue
			}
			// 零尺寸 = 不可见，直接跳过（也让「空 div 变成有内容」被识别为新出现）
			if (rect.width <= 0 || rect.height <= 0) continue
			var text = ''
			try {
				text = clip(el.textContent, 120)
			} catch {
				text = ''
			}
			var path = nodePathOf(el)
			var roleAttr = el.getAttribute && el.getAttribute('role')
			nodes.push({
				uid: opts.markUids === false ? undefined : markUid(el),
				key: el.nodeName.toLowerCase() + '#' + path.join('.') + '|' + text.slice(0, 60),
				tag: el.nodeName.toLowerCase(),
				role: roleAttr ? String(roleAttr).trim().toLowerCase() : undefined,
				text: text,
				// 属性 + 索引链：元素可能在处理到它之前就消失了（悬停展开的菜单、toast），
				// 有这两样就能直接从快照事实重建 ElementRef，不必再靠 locator 找回元素。
				attributes: readAttributes(el),
				nodePath: path,
				rect: {
					x: round(rect.left),
					y: round(rect.top),
					width: round(rect.width),
					height: round(rect.height),
				},
			})
		}
		return {
			url: location.href,
			nodes: nodes,
			viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
			dpr: window.devicePixelRatio || 1,
			scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
		}
	}

	/** 清掉临时 uid 标记（含 open shadow root 里的） */
	window.__rrClearUids = function () {
		var removed = 0
		function clearIn(root) {
			var list
			try {
				list = root.querySelectorAll('[data-rr-uid]')
			} catch {
				return
			}
			for (var i = 0; i < list.length; i++) {
				list[i].removeAttribute('data-rr-uid')
				removed++
			}
			try {
				var all = root.querySelectorAll('*')
				for (var j = 0; j < all.length; j++) {
					if (all[j].shadowRoot) clearIn(all[j].shadowRoot)
				}
			} catch {
				/* 忽略 */
			}
		}
		clearIn(document)
		return removed
	}
})()
