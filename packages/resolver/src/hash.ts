/**
 * 元素指纹（stableHash）—— **必须与 `@rr/recorder` 的 `stableHashOf` 逐字节一致**。
 *
 * 为什么抄一份而不是 import：包依赖方向是 `resolver → schema`、`recorder → schema`，
 * resolver 不能反向依赖 recorder。所以这里复刻同一算法，并用
 * `packages/executor/src/stablehash.compat.test.ts` 做**跨包一致性回归**（任何一边改算法，测试立刻红）。
 * 建议后续把该函数上移到 `@rr/schema` 彻底去重（已报给 Lead）。
 *
 * 算法（与 recorder/src/element.ts:150-166 完全一致）：
 *   payload = [tag, role ?? '', accessibleName ?? '', attrPart, nodePath.join('.')].join('\u0000')
 *   attrPart = Object.keys(attrs).sort().map(k => `${k}=${attrs[k]}`).join('&')
 *   stableHash = sha1(payload) hex
 *
 * 属性策略（与 recorder/src/element.ts:43-55,132-177 一致）：
 *   - allow：FINGERPRINT_ATTRS 白名单 + 任意 `data-*`；
 *   - deny：`class` / `style` / `data-rr-*`（自身打的标记）；
 *   - 空值丢弃；看起来像动态值（uuid / 16+ hex / 4+ 连续数字）的丢弃。
 *
 * 为什么不把 class 计入：fixture /basic 的 #volatile-class-btn 每秒换一次 class，
 * 但 id / data-testid / aria-label 稳定 —— 这正是 L2 要能命中而「按 class 生成 css」会挂的场景。
 */
import { createHash } from 'node:crypto'

import type { Fingerprint } from '@rr/schema'

/** 仅作文档标记；**不参与** payload（payload 必须与 recorder 一致） */
export const STABLE_HASH_VERSION = 'rr-stable-hash-v2-recorder-compat'

/** 与 recorder 的 FINGERPRINT_ATTRS 一致 */
export const FINGERPRINT_ATTRS = [
	'id',
	'name',
	'type',
	'role',
	'placeholder',
	'title',
	'alt',
	'for',
	'aria-label',
	'aria-labelledby',
	'aria-describedby',
] as const

export interface StableAttrPolicy {
	allowExact: readonly string[]
	allowPrefix: readonly string[]
	denyExact: readonly string[]
}

export const STABLE_ATTR_POLICY: StableAttrPolicy = {
	allowExact: FINGERPRINT_ATTRS,
	allowPrefix: ['data-'],
	denyExact: ['class', 'style'],
}

/** 元素上「不是内容」的标签，指纹遍历时直接跳过 */
export const NON_CONTENT_TAGS = ['script', 'style', 'head', 'meta', 'link', 'noscript', 'template']

/** 动态值判定（与 recorder 的 isDynamicValue 一致）：uuid / 长 hex / 4 位以上数字 / 时间戳 */
export function isDynamicValue(value: string): boolean {
	if (!value) return false
	if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return true
	if (/^[0-9a-f]{16,}$/i.test(value)) return true
	if (/\d{4,}/.test(value)) return true
	if (/^\d{10,}$/.test(value)) return true
	return false
}

/** 是否属于指纹属性（录制侧与回放侧共用同一判定） */
export function isStableAttr(
	name: string,
	policy: StableAttrPolicy = STABLE_ATTR_POLICY,
): boolean {
	const lower = name.toLowerCase()
	if (lower.startsWith('data-rr-')) return false // 自己打的标记不参与指纹
	if (policy.denyExact.includes(lower)) return false
	if (policy.allowExact.includes(lower)) return true
	return policy.allowPrefix.some((prefix) => lower.startsWith(prefix))
}

/**
 * 过滤后的属性表（**保持原值不改写**，与 recorder 的 pickFingerprintAttrs 一致）。
 * 注意：不做空白归一化 —— 归一化会让 hash 与录制侧对不上。
 */
export function stableAttrsOf(
	raw: Record<string, string>,
	policy: StableAttrPolicy = STABLE_ATTR_POLICY,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const key of Object.keys(raw).sort()) {
		if (!isStableAttr(key, policy)) continue
		const value = raw[key]
		if (value === undefined || value === '') continue
		if (isDynamicValue(value)) continue
		out[key.toLowerCase()] = value
	}
	return out
}

/** 文本归一化：仅用于可访问名/文本比较（**不用于 hash 属性值**） */
export function normalizeText(value?: string | null): string {
	if (!value) return ''
	return value.replace(/\s+/g, ' ').trim()
}

export interface HashInput {
	tag: string
	role?: string
	accessibleName?: string
	attrs: Record<string, string>
	nodePath?: number[]
}

/** payload 字符串（与 recorder 逐字节一致，便于跨包回归与人工排查） */
export function canonicalHashInput(input: HashInput): string {
	const attrPart = Object.keys(input.attrs)
		.sort()
		.map((key) => `${key}=${input.attrs[key]}`)
		.join('&')
	const pathPart = (input.nodePath ?? []).join('.')
	return [input.tag, input.role ?? '', input.accessibleName ?? '', attrPart, pathPart].join('\u0000')
}

export function computeStableHash(input: HashInput): string {
	return createHash('sha1').update(canonicalHashInput(input)).digest('hex')
}

/** 从录制产物 Fingerprint 重算 hash（校验/调试用；nodePath 参与，与录制侧一致） */
export function computeHashFromFingerprint(fingerprint: Fingerprint): string {
	return computeStableHash({
		tag: fingerprint.tag,
		...(fingerprint.role !== undefined ? { role: fingerprint.role } : {}),
		...(fingerprint.accessibleName !== undefined
			? { accessibleName: fingerprint.accessibleName }
			: {}),
		attrs: fingerprint.attrs,
		...(fingerprint.nodePath !== undefined ? { nodePath: fingerprint.nodePath } : {}),
	})
}

/* ------------------------------------------------------------------ */
/* 页面内采集脚本（page.evaluate 用；不能引用闭包，全部走 arg）           */
/* ------------------------------------------------------------------ */

export interface InPageRect {
	x: number
	y: number
	width: number
	height: number
}

export interface InPageCandidate {
	uid: string
	tag: string
	role: string
	name: string
	attrs: Record<string, string>
	nodePath: number[]
	rect: InPageRect
	visible: boolean
}

export interface InPageCollectArg {
	policy: StableAttrPolicy
	/** 指纹字段过滤条件（来自 flow 的 fingerprint） */
	tag: string
	role?: string
	name?: string
	attrs: Record<string, string>
	/** 命中后打的标记属性名，L2 靠它转成 Locator */
	marker: string
	/** 最多返回多少个（防止 tag 单一匹配时爆量） */
	limit: number
}

/**
 * 在页面内按指纹字段筛选元素并打标记。
 *
 * 注意：这个函数会被序列化后在浏览器里执行，**不能引用模块作用域的任何变量**。
 * open shadow root 会递归进入；closed shadow 浏览侧不可见（需要 CDP，M1 不支持）。
 * nodePath 语义与 recorder/capture/capture.js 的 nodePathOf 一致：
 * documentElement 之下的 children 索引链（不含 html 自身），最多 64 层。
 */
export function collectFingerprintCandidates(arg: InPageCollectArg): InPageCandidate[] {
	const policy = arg.policy
	const skipTags = [
		'script',
		'style',
		'head',
		'meta',
		'link',
		'noscript',
		'template',
		'html',
	]
	const normalize = (value: string | null | undefined): string =>
		(value ?? '').replace(/\s+/g, ' ').trim()

	const isDynamicValue = (value: string): boolean => {
		if (!value) return false
		if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return true
		if (/^[0-9a-f]{16,}$/i.test(value)) return true
		if (/\d{4,}/.test(value)) return true
		if (/^\d{10,}$/.test(value)) return true
		return false
	}

	const isStableAttr = (name: string): boolean => {
		const lower = name.toLowerCase()
		if (lower.indexOf('data-rr-') === 0) return false
		if (policy.denyExact.indexOf(lower) >= 0) return false
		if (policy.allowExact.indexOf(lower) >= 0) return true
		for (const prefix of policy.allowPrefix) {
			if (lower.indexOf(prefix) === 0) return true
		}
		return false
	}

	const stableAttrs = (el: Element): Record<string, string> => {
		const out: Record<string, string> = {}
		for (const attr of Array.from(el.attributes)) {
			if (!isStableAttr(attr.name)) continue
			if (attr.value === '') continue
			if (isDynamicValue(attr.value)) continue
			out[attr.name.toLowerCase()] = attr.value
		}
		return out
	}

	/** documentElement 之下的 children 索引链（与 recorder 的 nodePathOf 一致） */
	const nodePathOf = (el: Element): number[] => {
		const path: number[] = []
		let node: Element | null = el
		let guard = 0
		while (node && node.parentElement && node !== document.documentElement && guard++ < 64) {
			const parent: Element = node.parentElement
			let index = 0
			let cur = parent.firstElementChild
			while (cur && cur !== node) {
				index += 1
				cur = cur.nextElementSibling
			}
			path.unshift(index)
			node = parent
		}
		return path
	}

	/** 隐式 role 的近似映射（页面内拿不到 a11y tree，只覆盖常见标签） */
	const implicitRole = (el: Element): string => {
		const explicit = el.getAttribute('role')
		if (explicit) return normalize(explicit).toLowerCase()
		const tag = el.tagName.toLowerCase()
		if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
		if (tag === 'button') return 'button'
		if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox'
		if (tag === 'textarea') return 'textbox'
		if (tag === 'img') return 'img'
		if (tag === 'option') return 'option'
		if (tag === 'li') return 'listitem'
		if (tag === 'ul' || tag === 'ol') return 'list'
		if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6')
			return 'heading'
		if (tag === 'table') return 'table'
		if (tag === 'tr') return 'row'
		if (tag === 'td') return 'cell'
		if (tag === 'th') return 'columnheader'
		if (tag === 'nav') return 'navigation'
		if (tag === 'main') return 'main'
		if (tag === 'header') return 'banner'
		if (tag === 'footer') return 'contentinfo'
		if (tag === 'form') return 'form'
		if (tag === 'dialog') return 'dialog'
		if (tag === 'input') {
			const type = (el.getAttribute('type') ?? 'text').toLowerCase()
			if (type === 'checkbox') return 'checkbox'
			if (type === 'radio') return 'radio'
			if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
			if (type === 'search') return 'searchbox'
			if (type === 'range') return 'slider'
			if (type === 'number') return 'spinbutton'
			if (type === 'file') return 'button'
			return 'textbox'
		}
		return ''
	}

	/** 可访问名的近似（aria-label > aria-labelledby > label[for] > alt > title > 文本） */
	const accessibleName = (el: Element): string => {
		const aria = el.getAttribute('aria-label')
		if (aria && normalize(aria)) return normalize(aria)
		const labelledBy = el.getAttribute('aria-labelledby')
		if (labelledBy) {
			const parts = labelledBy
				.split(/\s+/)
				.map((id) => document.getElementById(id)?.textContent ?? '')
			const joined = normalize(parts.join(' '))
			if (joined) return joined
		}
		// 关联 label（input/select/textarea/button 都适用）：原生 .labels 优先，再退回 label[for=id]
		const withLabels = el as Element & { labels?: ArrayLike<HTMLLabelElement> | null }
		const labels = withLabels.labels
		if (labels && labels.length > 0) {
			for (const label of Array.from(labels)) {
				const byLabel = normalize(label.textContent)
				if (byLabel) return byLabel
			}
		}
		const id = el.getAttribute('id')
		if (id) {
			const label = document.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]')
			if (label) {
				const byLabel = normalize(label.textContent)
				if (byLabel) return byLabel
			}
		}
		const alt = el.getAttribute('alt')
		if (alt && normalize(alt)) return normalize(alt)
		const title = el.getAttribute('title')
		if (title && normalize(title)) return normalize(title)
		return normalize(el.textContent)
	}

	const isVisible = (el: Element): boolean => {
		const anyEl = el as Element & { checkVisibility?: (opts?: object) => boolean }
		if (typeof anyEl.checkVisibility === 'function') {
			try {
				return anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
			} catch {
				/* 老内核不支持参数，退回几何判断 */
			}
		}
		return el.getClientRects().length > 0
	}

	const matches = (el: Element): boolean => {
		const tag = el.tagName.toLowerCase()
		if (tag !== arg.tag.toLowerCase()) return false
		if (arg.role && implicitRole(el) !== arg.role.toLowerCase()) return false
		if (arg.name) {
			if (accessibleName(el) !== normalize(arg.name)) return false
		}
		const wantKeys = Object.keys(arg.attrs)
		if (wantKeys.length > 0) {
			const live = stableAttrs(el)
			for (const key of wantKeys) {
				if (live[key] !== arg.attrs[key]) return false
			}
		}
		return true
	}

	// 清掉上一次残留的标记（崩溃/超时的 run 可能留下）
	for (const stale of Array.from(document.querySelectorAll('[' + arg.marker + ']'))) {
		stale.removeAttribute(arg.marker)
	}

	const out: InPageCandidate[] = []
	let counter = 0

	const visit = (root: Document | ShadowRoot | Element): void => {
		if (out.length >= arg.limit) return
		for (const el of Array.from(root.querySelectorAll('*'))) {
			if (out.length >= arg.limit) return
			const tag = el.tagName.toLowerCase()
			if (skipTags.indexOf(tag) < 0 && matches(el)) {
				counter += 1
				const uid = 'rr' + counter
				el.setAttribute(arg.marker, uid)
				const rect = el.getBoundingClientRect()
				out.push({
					uid,
					tag,
					role: implicitRole(el),
					name: accessibleName(el),
					attrs: stableAttrs(el),
					nodePath: nodePathOf(el),
					rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
					visible: isVisible(el),
				})
			}
			// open shadow root 递归（closed 在页面内不可见）
			const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
			if (shadow) visit(shadow)
		}
	}

	visit(document)
	return out
}

/** 清掉所有 L2 标记属性（必须放在 finally 里，绝不污染页面） */
export function removeFingerprintMarkers(arg: { marker: string }): number {
	const marked = Array.from(document.querySelectorAll('[' + arg.marker + ']'))
	for (const el of marked) el.removeAttribute(arg.marker)
	return marked.length
}
