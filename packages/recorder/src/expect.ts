/**
 * expect 推断（朴素版）：比较「动作前 / 动作后」两帧页面签名，产出可回放校验的 Expect。
 *
 * 为什么朴素：M1 只做**零误报**的两条规则 ——
 * 1. url 变了 → `urlChange`（SPA pushState 也算，因为签名取的是 `page.url()`）
 * 2. 出现了新的可见元素 → `elementVisible`（挑「最具体」的那一个：有文本、面积最小、排除 html/body 容器）
 *
 * 不做 textChange / domSignature：它们误报率高，宁可不校验也不要制造 flaky。
 * 纯函数，不碰浏览器。
 */
import type { Expect } from '@rr/schema'

import type { PageSignature, SignatureNode } from './types.js'

/** role 优先级：只保留高置信「用户真正关心的反馈」（toast / 对话框 / 标题类） */
const ROLE_PRIORITY = ['alert', 'status', 'dialog', 'alertdialog']

/**
 * tag 优先级：只保留语义强、不易随列表/数据变化的元素。
 * 真实站点回归后收窄：li / p / a / button / input 在动态列表、下拉、筛选场景里
 * 会频繁「出现又消失」，据此推断 elementVisible 会制造 flaky（TodoMVC 筛选、AntD 下拉都踩过）。
 */
const TAG_PRIORITY = ['dialog', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'output']

/** 这些 tag 只在没有更好候选时才用（容器类，面积大、语义弱） */
const WEAK_TAGS = new Set(['html', 'body', 'main', 'section', 'article', 'form', 'div', 'span'])

/**
 * 动作前后签名对比 → 推断 expect。
 *
 * 注意：`elementVisible` 的 `target` 需要 `SignatureNode.ref` 已经就位。
 * record() 的流程是「先 diff 出候选节点 → 只给最终选中的那一个补 ref → 再调用本函数」，
 * 这样纯函数不需要自己拍快照。
 */
export function inferExpect(before: PageSignature, after: PageSignature): Expect | undefined {
	if (after.url !== before.url) return { kind: 'urlChange', pattern: urlPattern(after.url) }

	const appeared = appearedNodes(before, after)
	const picked = pickExpectTarget(appeared)
	if (picked?.ref) return { kind: 'elementVisible', target: picked.ref }
	return undefined
}

/** 动作后「新出现」的节点：key 不在 before 里、且带 ref 才有意义 */
export function appearedNodes(before: PageSignature, after: PageSignature): SignatureNode[] {
	const beforeKeys = new Set(before.nodes.map((n) => n.key))
	return after.nodes.filter((n) => !beforeKeys.has(n.key))
}

/**
 * 从新出现的节点里挑一个作为 expect 目标。
 * 排序维度：role 优先级 > 有文本 > 面积小 > DOM 顺序靠后（越靠后越像「新插入的反馈」）。
 */
export function pickExpectTarget(nodes: SignatureNode[]): SignatureNode | undefined {
	// 尺寸为 0 的节点（隐藏输入框、关闭的下拉选项）一律不选：
	// 录制时它们可能刚好在 DOM 里，但回放时往往不可见/不存在
	// 白名单：只接受「语义强、非列表项」的元素。列表项/链接/按钮/输入在动态页面里
	// 会随数据渲染频繁出现消失，据此断言 elementVisible 是 flaky 的主要来源。
	const ALLOWED_TAGS = new Set(['dialog', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'output'])
	const ALLOWED_ROLES = new Set(['alert', 'status', 'dialog', 'alertdialog'])
	const usable = nodes
		.filter((n) => n.rect.width >= 1 && n.rect.height >= 1)
		.filter((n) => ALLOWED_TAGS.has(n.tag) || ALLOWED_ROLES.has(n.role ?? ''))
	if (!usable.length) return undefined
	const scored = usable.map((node, index) => ({ node, index, score: scoreNode(node) }))
	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score
		return b.index - a.index
	})
	return scored[0]?.node
}

function hasText(node: SignatureNode): boolean {
	return typeof node.text === 'string' && node.text.trim().length > 0
}

function scoreNode(node: SignatureNode): number {
	let score = 0
	const role = node.role
	if (role) {
		const rank = ROLE_PRIORITY.indexOf(role)
		if (rank >= 0) score -= (ROLE_PRIORITY.length - rank) * 10
	}
	const tagRank = TAG_PRIORITY.indexOf(node.tag)
	if (tagRank >= 0) score -= (TAG_PRIORITY.length - tagRank) * 2
	if (hasText(node)) score -= 8
	else score += 6
	if (WEAK_TAGS.has(node.tag)) score += 4
	// 面积越大越可能是容器，扣分（用 log 压一下，避免超大容器分数爆掉）
	const area = Math.max(node.rect.width, 1) * Math.max(node.rect.height, 1)
	score += Math.log10(area)
	return score
}

/**
 * 把 URL 变成一个「回放时能容忍动态段」的 pattern。
 *
 * 规则（保持可读，不引入 glob 依赖）：
 * - 数字段、uuid、长十六进制段 → `*`
 * - 丢弃 hash；query 只保留形状（有 query → `?*`）
 */
export function urlPattern(rawUrl: string): string {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return rawUrl
	}
	const segments = url.pathname
		.split('/')
		.map((segment) => (isDynamicSegment(segment) ? '*' : segment))
	let pattern = `${url.origin}${segments.join('/')}`
	if (url.search) pattern += '?*'
	return pattern
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_RE = /^[0-9a-f]{16,}$/i
const NUMERIC_RE = /^\d+$/

function isDynamicSegment(segment: string): boolean {
	if (!segment) return false
	if (NUMERIC_RE.test(segment)) return true
	if (UUID_RE.test(segment)) return true
	if (HEX_RE.test(segment)) return true
	// 纯数字 + 分隔符（如 2024-01-02、1-2-3）
	if (/^[\d\-_.]+$/.test(segment) && /\d/.test(segment)) return true
	return false
}

/** 空签名（录制起点还没有任何动作时用） */
export function emptySignature(url: string): PageSignature {
	return { url, nodes: [] }
}
