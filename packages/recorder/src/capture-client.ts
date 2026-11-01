/**
 * Node 侧的「浏览器桥」：安装采集、把元素找回来、校验候选、抓签名。
 *
 * 分工边界（重要）：
 * - 页面内（capture.js）只回事实；
 * - **候选的最终裁决在这里**——用 Playwright 自己的 locator 判 `count()===1 && visible`，
 *   这样「录制时选中的元素」和「回放时解析到的元素」是同一套语义，不会漂移。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Candidate } from '@rr/schema'
import type { BrowserContext, ElementHandle, Frame, Locator, Page } from 'playwright'

import type { PageSignature, RawElementFacts, RawEvent } from './types.js'

/** role 候选的 value 形状（对应 schema 里 Candidate.value 的对象分支） */
interface RoleCandidateValue {
	role: string
	name?: string
	exact?: boolean
}

type RoleName = Parameters<Frame['getByRole']>[0]

/** capture.js 的绝对路径（source-first，用 import.meta.url 定位，不依赖 cwd） */
export const CAPTURE_SCRIPT_PATH = fileURLToPath(new URL('../capture/capture.js', import.meta.url))

/** 页面 → Node 的事件通道名 */
export const EMIT_BINDING = '__rrEmit'

/** 元素临时标记属性（不进 IR，处理完清掉） */
export const UID_ATTR = 'data-rr-uid'

/** 签名 / 校验时最多看多少个 frame（防止 iframe 地狱把录制拖死） */
const MAX_FRAMES = 10
/** 每帧最多采多少个可见节点 */
const MAX_SNAPSHOT_NODES = 120

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

/**
 * 事件回调：`(sourcePage, frame, payload)`。
 * 多标签页归属必须靠 `source.page`——frame 只能说明「哪个 frame」，说明不了「哪个 tab」。
 */
export type EmitHandler = (sourcePage: Page, frame: Frame, payload: unknown) => void

/** 装事件通道 + 注入采集脚本。顺序：先 exposeBinding 再 addInitScript。 */
export async function installCapture(context: BrowserContext, onEmit: EmitHandler): Promise<void> {
	await context.exposeBinding(EMIT_BINDING, (source, payload: unknown) => {
		onEmit(source.page, source.frame, payload)
	})
	await context.addInitScript({ path: CAPTURE_SCRIPT_PATH })
}

/**
 * 把采集脚本注入一个**已经存在**的文档。
 *
 * 为什么需要：`context.addInitScript` 覆盖不到 popup（window.open / target=_blank）的
 * 首个真实文档 —— 实测 popup 里 `document.__rrCaptureInstalled` 为 undefined、一个事件都收不到。
 * 这里把它当「表达式」求值（`Runtime.evaluate` 语义，不受页面 CSP 限制），
 * capture.js 自身有 document 级幂等守卫，重复注入不会重复挂监听。
 */
let captureSourcePromise: Promise<string> | undefined
export function captureScriptSource(): Promise<string> {
	captureSourcePromise ??= readFile(CAPTURE_SCRIPT_PATH, 'utf8')
	return captureSourcePromise
}

export async function ensureCaptureInPage(page: Page): Promise<boolean> {
	try {
		await page.evaluate(await captureScriptSource())
		return true
	} catch {
		// 页面正在导航 / 有模态框：下次 domcontentloaded 再试
		return false
	}
}

/* ------------------------------------------------------------------ */
/* 页面内 pull API                                                     */
/* ------------------------------------------------------------------ */

/** 页面内 `__rrSnapshot()` 的返回形状 */
interface SnapshotPayload {
	url?: string
	nodes?: Array<{
		uid?: string
		key: string
		tag: string
		role?: string
		text: string
		attributes?: Record<string, string>
		nodePath?: number[]
		rect: { x: number; y: number; width: number; height: number }
	}>
	viewport?: { width: number; height: number }
	dpr?: number
	scroll?: { x: number; y: number }
}

/**
 * 抓一份全页签名（逐 frame 取，key 前缀 frame 序号避免跨帧撞车）。
 * @param indexOfFrame 把 Frame 映射成全局 frame 序号（record() 传 ensureFrameIndex）：
 *   签名里带上它，`inferExpect` 挑中的「新出现元素」才能被正确解析回 Locator。
 */
export async function snapshotPage(
	page: Page,
	indexOfFrame?: (frame: Frame) => number,
): Promise<PageSignature> {
	const nodes: PageSignature['nodes'] = []
	const frames = page.frames().slice(0, MAX_FRAMES)
	for (let index = 0; index < frames.length; index++) {
		const frame = frames[index]!
		let payload: SnapshotPayload | undefined
		try {
			payload = await frame.evaluate(
				(opts) => (window as any).__rrSnapshot?.(opts) as SnapshotPayload | undefined,
				{ max: MAX_SNAPSHOT_NODES },
			)
		} catch {
			// frame 已销毁 / 正在导航：跳过
			continue
		}
		const frameIndex = indexOfFrame ? indexOfFrame(frame) : index
		for (const node of payload?.nodes ?? []) {
			nodes.push({
				...node,
				frameIndex,
				key: `${frameIndex}:${node.key}`,
				viewport: payload?.viewport,
				dpr: payload?.dpr,
				scroll: payload?.scroll,
			})
		}
	}
	return { url: page.url(), nodes }
}

/** 清掉所有临时 uid 标记 */
export async function clearUids(page: Page): Promise<void> {
	for (const frame of page.frames().slice(0, MAX_FRAMES)) {
		try {
			await frame.evaluate(() => (window as any).__rrClearUids?.())
		} catch {
			/* frame 已销毁，忽略 */
		}
	}
}

/* ------------------------------------------------------------------ */
/* 元素寻址                                                            */
/* ------------------------------------------------------------------ */

/** 用 uid 在一个 frame 里把元素找回来 */
export async function locateByUid(frame: Frame, uid: string): Promise<Locator | undefined> {
	const locator = frame.locator(`[${UID_ATTR}="${escapeAttrValue(uid)}"]`)
	try {
		if ((await locator.count()) !== 1) return undefined
		return locator
	} catch {
		return undefined
	}
}

/** 直接在页面里读一个元素的最新事实（位置可能已经变了，录完要刷新） */
export async function readFactsFromHandle(
	handle: ElementHandle,
): Promise<RawElementFacts | undefined> {
	try {
		const facts = await handle.evaluate(
			(el) =>
				((el.ownerDocument?.defaultView as any)?.__rrFacts?.(el) as RawElementFacts | undefined) ??
				null,
		)
		return facts ?? undefined
	} catch {
		return undefined
	}
}

export async function readFactsByUid(
	frame: Frame,
	uid: string,
): Promise<RawElementFacts | undefined> {
	const locator = await locateByUid(frame, uid)
	if (!locator) return undefined
	const handle = await locator.elementHandle({ timeout: 1000 }).catch(() => null)
	if (!handle) return undefined
	const facts = await readFactsFromHandle(handle as ElementHandle)
	await handle.dispose().catch(() => {})
	return facts
}

/** 这个 uid 现在是否还在（用来区分「元素被销毁」和「候选写错了」） */
export async function isUidAlive(frame: Frame, uid: string): Promise<boolean> {
	return (await locateByUid(frame, uid)) !== undefined
}

/* ------------------------------------------------------------------ */
/* 语义描述（role / accessible name）                                   */
/* ------------------------------------------------------------------ */

/**
 * 用 Playwright 自己的 `ariaSnapshot()` 拿 role + accessible name。
 *
 * 为什么不用页面内启发式：accessible name 是 400 行 accname 规则的产物
 * （aria-labelledby / name from content / label / placeholder / title …），
 * 自己再实现一套必然和回放端漂移。这里直接借用 Playwright 的实现，返回第一行：
 *   `- button "提交表单"` → { role: 'button', name: '提交表单' }
 */
export interface ElementDescription {
	role?: string
	name?: string
}

/** 空描述（拿不到 ariaSnapshot 时的兜底） */
export const EMPTY_DESCRIPTION: ElementDescription = {}

export async function describeElement(locator: Locator): Promise<ElementDescription> {
	let yaml: string
	try {
		yaml = await locator.ariaSnapshot({ timeout: 2000 })
	} catch {
		return EMPTY_DESCRIPTION
	}
	const firstLine = yaml.split('\n').find((line) => line.trim().length > 0)
	if (!firstLine) return EMPTY_DESCRIPTION
	const match = /^\s*-\s+([a-zA-Z][\w-]*)\s*(?:"((?:[^"\\]|\\.)*)")?/.exec(firstLine)
	if (!match) return EMPTY_DESCRIPTION
	const role = match[1]?.toLowerCase()
	const rawName = match[2]
	const name = rawName === undefined ? undefined : unescapeYamlString(rawName)
	return { role, name: name || undefined }
}

function unescapeYamlString(value: string): string {
	return value
		.replace(/\\(["\\])/g, '$1')
		.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
}

/* ------------------------------------------------------------------ */
/* 候选 → Locator / 校验                                                */
/* ------------------------------------------------------------------ */

/** 把候选翻译成 Playwright Locator（frame 作用域，保证 iframe 里的元素也能校验） */
export function buildLocator(frame: Frame, candidate: Candidate): Locator {
	switch (candidate.kind) {
		case 'testid':
			return frame.getByTestId(String(candidate.value))
		case 'role': {
			const value = candidate.value as RoleCandidateValue
			const role = value.role as RoleName
			if (value.name === undefined) return frame.getByRole(role)
			return frame.getByRole(role, { name: value.name, exact: value.exact ?? true })
		}
		case 'label':
			return frame.getByLabel(String(candidate.value))
		case 'text':
			return frame.getByText(String(candidate.value))
		case 'css':
			return frame.locator(String(candidate.value))
		case 'xpath':
			return frame.locator(`xpath=${String(candidate.value)}`)
	}
}

export type ValidationResult = 'ok' | 'ambiguous' | 'missing'

/**
 * 校验一个候选：
 * 1. `count() === 1`（唯一）
 * 2. 可见（`isVisible()`）
 * 3. **命中的确实是我们的元素**（比对 uid 标记，防止「唯一但不是它」）
 *
 * 第 3 步是关键：PW 的 `getByRole('button', {name:'提交'})` 唯一命中时也可能指向另一个
 * 长得一样的按钮，只判 count 会把「录错元素」写进 IR。
 */
export async function validateCandidate(
	frame: Frame,
	candidate: Candidate,
	uid: string,
): Promise<ValidationResult> {
	const locator = buildLocator(frame, candidate)
	let count = 0
	try {
		count = await locator.count()
	} catch {
		return 'missing'
	}
	if (count === 0) return 'missing'
	if (count > 1) return 'ambiguous'
	try {
		if (!(await locator.isVisible())) return 'missing'
	} catch {
		return 'missing'
	}
	const handle = await locator.elementHandle({ timeout: 1000 }).catch(() => null)
	if (!handle) return 'missing'
	try {
		const owned = await handle.evaluate((el, want) => el.getAttribute('data-rr-uid') === want, uid)
		return owned ? 'ok' : 'ambiguous'
	} catch {
		return 'missing'
	} finally {
		await handle.dispose().catch(() => {})
	}
}

/** 依次校验候选，返回通过的那些（保持原顺序 = score 升序） */
export async function validateCandidates(
	frame: Frame,
	candidates: Candidate[],
	uid: string,
): Promise<{ accepted: Candidate[]; rejected: Candidate[] }> {
	const accepted: Candidate[] = []
	const rejected: Candidate[] = []
	for (const candidate of candidates) {
		const result = await validateCandidate(frame, candidate, uid)
		if (result === 'ok') accepted.push(candidate)
		else rejected.push(candidate)
	}
	return { accepted, rejected }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 收 RawEvent 时把 binding payload 收敛成内部结构（NaN/字符串 ts 一律兜底） */
export function normalizeEmitPayload(payload: unknown): RawEvent | undefined {
	if (!payload || typeof payload !== 'object') return undefined
	const raw = payload as Record<string, any>
	const kind = raw.kind
	if (typeof kind !== 'string') return undefined
	const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now()
	const event: RawEvent = {
		kind: kind as RawEvent['kind'],
		ts,
		frameUrl: typeof raw.frameUrl === 'string' ? raw.frameUrl : undefined,
		data: raw.data && typeof raw.data === 'object' ? raw.data : undefined,
		trusted: raw.trusted !== false,
	}
	const facts = raw.facts
	if (facts && typeof facts === 'object' && typeof facts.tag === 'string')
		event.facts = facts as RawElementFacts
	return event
}

/**
 * 抓元素区域截图（用于 crop）。
 *
 * **不要用 `locator.screenshot()`**：它会 scrollIntoView，导致录制时页面自己滚动 ——
 * 用户看到的就是"每输入一次页面闪一下"，而且滚动事件会被录制器当成用户操作录进 flow。
 * 这里用 `page.screenshot({ clip })`：不滚动、不改变焦点，clip 用文档坐标（视口 rect + 滚动偏移）。
 * 只支持主 frame（iframe 内的元素跳过 crop，回放不受影响）。
 */
export async function screenshotRegion(
	page: Page,
	frame: Frame,
	rect: { x: number; y: number; width: number; height: number },
	scroll: { x: number; y: number },
	path: string,
): Promise<boolean> {
	if (frame !== page.mainFrame()) return false
	if (rect.width < 1 || rect.height < 1) return false
	try {
		await page.screenshot({
			path,
			animations: 'disabled',
			timeout: 3000,
			clip: {
				x: Math.max(0, Math.round(rect.x + scroll.x)),
				y: Math.max(0, Math.round(rect.y + scroll.y)),
				width: Math.max(1, Math.round(rect.width)),
				height: Math.max(1, Math.round(rect.height)),
			},
		})
		return true
	} catch {
		return false
	}
}

export function escapeAttrValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
