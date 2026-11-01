/**
 * ElementRef 生成：把页面采来的事实（RawElementFacts）标准化成 IR 里的 `ElementRef`。
 *
 * 分工：
 * - **页面内**只采事实（tag / 属性白名单 / 文本 / rect / nodePath / 邻近文本）；
 * - **本文件**是纯函数，负责白名单筛属性、算 stableHash、**按启发式产出一串候选**；
 * - **record.ts** 再用 Playwright locator 逐个校验候选（`count()===1 && visible`），
 *   把通过的写回 `candidates`。校验失败的候选一律不进 IR —— 这是「录放语义不漂移」的关键。
 *
 * 候选 score 越小越可信（schema 要求数组按 score 升序，`validateFlowContract` 会检查）。
 */
import { createHash } from 'node:crypto'

import type { Candidate, ElementRef, Fingerprint, ObservedFacts } from '@rr/schema'

import type { RawElementFacts } from './types.js'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 候选 score：数字即优先级，越小越优先（与 selectorGenerator 的排序哲学一致） */
export const SCORE = {
	testid: 10,
	testidOther: 12,
	roleExact: 30,
	roleInexact: 36,
	label: 50,
	text: 70,
	textPartial: 76,
	cssHref: 300,
	cssClass: 650,
	cssId: 100,
	cssAttr: 150,
	cssPath: 300,
	xpath: 900,
} as const

/** 候选数量上限：IR 要可读，validation 也要快 */
const MAX_CANDIDATES = 8
/** 太长的文本不适合当候选（容易截断导致不唯一） */
const MAX_TEXT_CANDIDATE = 80

/** 指纹属性白名单：能标识「这个元素是谁」，而不是「它现在长什么样」 */
const FINGERPRINT_ATTRS = new Set([
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
])

/** testid 属性 → 优先级（第一个是 Playwright 的 testIdAttributeName 默认值） */
const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test'] as const

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 给定页面事实产出合法 `ElementRef`。
 *
 * - 若 facts.candidates 已由 record() 校验填好，直接用；
 * - 否则按启发式推导（可能是「未校验」的候选，仅供单测/降级场景）。
 */
export function buildElementRef(input: RawElementFacts): ElementRef {
	const observed = buildObservedFacts(input)
	const attrs = pickFingerprintAttrs(input.attributes)
	const fingerprint: Fingerprint = {
		tag: input.tag,
		role: input.role,
		accessibleName: input.accessibleName,
		attrs,
		stableHash: stableHashOf({
			tag: input.tag,
			role: input.role,
			accessibleName: input.accessibleName,
			attrs,
			nodePath: input.nodePath,
		}),
		nodePath: input.nodePath,
	}
	const candidates = (input.candidates?.length ? input.candidates : deriveCandidates(input)).slice(
		0,
		MAX_CANDIDATES,
	)
	// schema 硬要求：candidates min(1)。极端情况下给一个 nodePath 派生的 css 兜底。
	if (!candidates.length) candidates.push(fallbackCandidate(input))

	const ref: ElementRef = {
		observed,
		candidates: sortCandidates(candidates),
		fingerprint,
		frame: input.frame ?? { path: [] },
		nearbyText: input.nearbyText?.length ? input.nearbyText.slice(0, 4) : undefined,
		crop: input.crop,
	}
	const description = describeElementFacts(input)
	if (description) ref.description = description
	return ref
}

/** ObservedFacts：录制时的原始事实，回放/自愈不得修改 */
export function buildObservedFacts(input: RawElementFacts): ObservedFacts {
	return {
		tag: input.tag,
		attributes: { ...input.attributes },
		text: input.text,
		rect: {
			x: round(input.rect.x),
			y: round(input.rect.y),
			width: round(input.rect.width),
			height: round(input.rect.height),
		},
		scroll: { x: input.scroll?.x ?? 0, y: input.scroll?.y ?? 0 },
		viewport: { width: input.viewport?.width ?? 0, height: input.viewport?.height ?? 0 },
		dpr: input.dpr ?? 1,
		recordedAt: Math.round(input.recordedAt) || Date.now(),
		shadowRootType: input.shadowRootType,
		innerOffset: input.innerOffset,
	}
}

/* ------------------------------------------------------------------ */
/* 指纹                                                                */
/* ------------------------------------------------------------------ */

/** 只留「稳定标识」属性，并剔除看起来是动态值的（uuid / 长数字 / 时间戳） */
export function pickFingerprintAttrs(attributes: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [name, value] of Object.entries(attributes)) {
		if (name === 'data-rr-uid' || name === 'class' || name === 'style') continue
		if (!FINGERPRINT_ATTRS.has(name) && !name.startsWith('data-')) continue
		if (!value) continue
		if (isDynamicValue(value)) continue
		out[name] = value
	}
	return out
}

/**
 * `stableHash` = sha1(tag + role + name + 稳定属性 + nodePath)。
 * nodePath 放进去是为了让「两个一模一样的按钮」能被区分开；
 * 它只是最后手段，L1 语义候选命中时根本不会用到。
 */
export function stableHashOf(input: {
	tag: string
	role?: string
	accessibleName?: string
	attrs: Record<string, string>
	nodePath?: number[]
}): string {
	const attrPart = Object.keys(input.attrs)
		.sort()
		.map((key) => `${key}=${input.attrs[key]}`)
		.join('&')
	const pathPart = (input.nodePath ?? []).join('.')
	const payload = [
		input.tag,
		input.role ?? '',
		input.accessibleName ?? '',
		attrPart,
		pathPart,
	].join('\u0000')
	return createHash('sha1').update(payload).digest('hex')
}

/** 动态值判定：uuid / 很长的十六进制 / 4 位以上数字 / 时间戳样式 */
export function isDynamicValue(value: string): boolean {
	if (!value) return false
	if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return true
	if (/^[0-9a-f]{16,}$/i.test(value)) return true
	if (/\d{4,}/.test(value)) return true
	// 形如 "2024-01-02T10:00:00" / "item-1712345678901"
	if (/^\d{10,}$/.test(value)) return true
	return false
}

/* ------------------------------------------------------------------ */
/* 候选生成                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从事实里推导候选（未校验）。
 *
 * 顺序即优先级：testid → role+name → label → text → css(id / 稳定属性 / 路径) → xpath。
 * 注意 role+name 需要 Node 侧从 ariaSnapshot 拿到的 role/accessibleName；
 * 拿不到时就不生成，宁缺毋滥。
 */
export function deriveCandidates(input: RawElementFacts): Candidate[] {
	const out: Candidate[] = []
	const attrs = input.attributes
	const tag = input.tag

	// 1) testid
	for (const attr of TESTID_ATTRS) {
		const value = attrs[attr]
		if (!value) continue
		// 只有 data-testid 能走 getByTestId（默认 testIdAttributeName）；其余走 css
		if (attr === 'data-testid')
			out.push({ kind: 'testid', value, score: SCORE.testid, source: 'record' })
		else
			out.push({
				kind: 'css',
				value: `[${attr}=${quoteAttr(value)}]`,
				score: SCORE.testidOther,
				source: 'record',
			})
	}

	// 2) role + accessible name
	if (input.role && isUsefulRole(input.role)) {
		const name = input.accessibleName?.trim()
		if (name && name.length <= MAX_TEXT_CANDIDATE) {
			out.push({
				kind: 'role',
				value: { role: input.role, name, exact: true },
				score: SCORE.roleExact,
				source: 'record',
			})
			// 同时产出「精确」和「子串」两种：文本一改精确就失效，子串更抗漂移
			out.push({
				kind: 'role',
				value: { role: input.role, name, exact: false },
				score: SCORE.roleInexact,
				source: 'record',
			})
		} else {
			// 无名字的 role 也留着：至少能在 L2 兜底时限定元素集合
			out.push({
				kind: 'role',
				value: { role: input.role },
				score: SCORE.roleInexact + 10,
				source: 'record',
			})
		}
	}

	// 3) label
	const label = input.labels?.find((text) => text && text.length <= MAX_TEXT_CANDIDATE)
	if (label) out.push({ kind: 'label', value: label, score: SCORE.label, source: 'record' })

	// 4) 可见文本（只对「文本就是它自己」的元素有意义）
	const text = input.text?.trim()
	if (text && text.length <= MAX_TEXT_CANDIDATE && isTextCandidateTag(tag)) {
		out.push({ kind: 'text', value: text, score: SCORE.text, source: 'record' })
	}

	// 4.5) 链接 href（真实站点上比「文本」稳：同文本的链接可能很多）
	const href = attrs['href']
	if (tag === 'a' && href && isStableHref(href)) {
		out.push({
			kind: 'css',
			value: `a[href=${quoteAttr(href)}]`,
			score: SCORE.cssHref,
			source: 'record',
		})
	}

	// 4.6) 稳定 class（组件库/企业后台常见；动态 token 会被过滤）
	const classSelector = classSelectorOf(tag, input.className)
	if (classSelector)
		out.push({ kind: 'css', value: classSelector, score: SCORE.cssClass, source: 'record' })

	// 5) css
	const id = attrs['id']
	if (id && !isDynamicValue(id))
		out.push({ kind: 'css', value: `#${cssIdent(id)}`, score: SCORE.cssId, source: 'record' })
	const nameAttr = attrs['name']
	if (nameAttr && !isDynamicValue(nameAttr))
		out.push({
			kind: 'css',
			value: `${tag}[name=${quoteAttr(nameAttr)}]`,
			score: SCORE.cssAttr,
			source: 'record',
		})
	const placeholder = attrs['placeholder']
	if (placeholder)
		out.push({
			kind: 'css',
			value: `${tag}[placeholder=${quoteAttr(placeholder)}]`,
			score: SCORE.cssAttr + 5,
			source: 'record',
		})

	// 6) xpath（nodePath 派生，最后手段）
	const xpath = xpathFromNodePath(input.nodePath)
	if (xpath) out.push({ kind: 'xpath', value: xpath, score: SCORE.xpath, source: 'record' })

	return sortCandidates(dedupeCandidates(out))
}

function fallbackCandidate(input: RawElementFacts): Candidate {
	const xpath = xpathFromNodePath(input.nodePath)
	if (xpath) return { kind: 'xpath', value: xpath, score: SCORE.xpath, source: 'record' }
	return { kind: 'css', value: input.tag, score: SCORE.cssPath, source: 'record' }
}

const NON_TEXT_CANDIDATE_TAGS = new Set(['input', 'select', 'textarea', 'img', 'html', 'body'])

function isTextCandidateTag(tag: string): boolean {
	return !NON_TEXT_CANDIDATE_TAGS.has(tag)
}

/** `getByRole` 对 generic/none/presentation 没有意义，跳过 */
function isUsefulRole(role: string): boolean {
	const lower = role.toLowerCase()
	return lower !== 'generic' && lower !== 'none' && lower !== 'presentation' && lower !== 'fragment'
}

/** 去重（同 kind + 同 value 只留 score 最低的） */
export function dedupeCandidates(candidates: Candidate[]): Candidate[] {
	const seen = new Map<string, Candidate>()
	for (const candidate of candidates) {
		const key = `${candidate.kind}:${JSON.stringify(candidate.value)}`
		const existing = seen.get(key)
		if (!existing || candidate.score < existing.score) seen.set(key, candidate)
	}
	return [...seen.values()]
}

/** 按 score 升序（schema 契约要求）+ 稳定排序（同分保持插入顺序） */
export function sortCandidates(candidates: Candidate[]): Candidate[] {
	return candidates
		.map((candidate, index) => ({ candidate, index }))
		.sort((a, b) =>
			a.candidate.score === b.candidate.score
				? a.index - b.index
				: a.candidate.score - b.candidate.score,
		)
		.map((entry) => entry.candidate)
}

/* ------------------------------------------------------------------ */
/* 描述 / 工具                                                         */
/* ------------------------------------------------------------------ */

/** 人类可读的一句话描述（给 CLI inspect / 未来 UI 用） */
export function describeElementFacts(input: RawElementFacts): string | undefined {
	const parts: string[] = [input.tag]
	const id = input.attributes['id']
	if (id) parts.push(`#${id}`)
	const testid = input.attributes['data-testid']
	if (testid) parts.push(`[testid=${testid}]`)
	if (input.role) parts.push(`role=${input.role}`)
	if (input.accessibleName) parts.push(`name="${truncate(input.accessibleName, 40)}"`)
	else if (input.text) parts.push(`text="${truncate(input.text, 40)}"`)
	return parts.join(' ')
}

/**
 * nodePath（从 documentElement 子节点往下的 children 索引链）→ 绝对 xpath。
 * 例：nodePath = [0, 0, 1] → `/html/*[1]/*[1]/*[2]`（body → div → 第 2 个元素）。
 * 用 `*[n]` 而不是具体 tag：录制时只采了索引，没采中间层的 tag。
 */
export function xpathFromNodePath(nodePath: number[] | undefined): string | undefined {
	if (!nodePath || !nodePath.length) return undefined
	return `/html${nodePath.map((index) => `/*[${index + 1}]`).join('')}`
}

/** CSS 属性值：双引号包起来并转义（够用且不依赖 CSS.escape） */
function quoteAttr(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** CSS id 选择器转义（按 https://drafts.csswg.org/cssom/#serialize-an-identifier 的常用子集） */
export function cssIdent(value: string): string {
	let out = ''
	for (let i = 0; i < value.length; i++) {
		const ch = value[i]!
		const code = ch.charCodeAt(0)
		const isDigit = code >= 0x30 && code <= 0x39
		if (isDigit && (i === 0 || (i === 1 && value[0] === '-'))) {
			out += `\\${code.toString(16)} `
			continue
		}
		if (/[a-zA-Z0-9_-]/.test(ch) || code >= 0x80) out += ch
		else out += `\\${ch}`
	}
	return out
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

function round(value: number): number {
	return Math.round(value * 100) / 100
}

/** href 是否稳定到可以做精确选择器（排除 javascript:、纯锚点、含随机段） */
function isStableHref(href: string): boolean {
	if (!href) return false
	if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return false
	if (href.length > 180) return false
	if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(href)) return false
	return true
}

/** 过滤动态 class token（CSS-in-JS hash、React scoped、长数字等），最多取两个稳定 token */
function classSelectorOf(tag: string, className: string | undefined): string | undefined {
	if (!className) return undefined
	const tokens = className
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean)
		.filter((t) => t.length >= 2 && t.length <= 40)
		.filter((t) => !/^[_a-z]?[0-9a-f]{6,}$/i.test(t)) // css hash 类
		.filter((t) => !/\d{3,}/.test(t)) // 长数字（日期/计数）
		.filter((t) => !/^(css|sc|jsx|emotion|svelte)-/i.test(t))
	const picked = tokens.slice(0, 2)
	if (!picked.length) return undefined
	return `${tag}.${picked.map((t) => t.replace(/([:./[\]])/g, '\\$1')).join('.')}`
}
