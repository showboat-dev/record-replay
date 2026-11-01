/**
 * record() —— 录制流程编排。
 *
 * 时序（每一步都有明确理由）：
 *
 *   launch chromium → newContext(viewport) → exposeBinding('__rrEmit') + addInitScript(capture.js)
 *   → goto(startUrl) → 抓初始签名 sig0
 *   → 事件进 buffer
 *   → 每 100ms tick：距最后一个事件 ≥ 500ms 就把 buffer 拿去合流（coalesceEvents）
 *   → 每个动作：等稳定点（连续 2 帧布局不变 + 300ms 静默）
 *              → 用 uid 把元素找回来看「最新事实」
 *              → ariaSnapshot 拿 role/name
 *              → 候选逐个 locator 校验（count===1 && visible && 命中确实是它）
 *              → 生成 ElementRef（含 fingerprint/stableHash/crop 截图）
 *              → expect = inferExpect(前一步签名, 当前签名)
 *   → stop（drive resolve / stopSignal / Ctrl+C）→ 冲掉最后一批 → 落 flow.json（写前 zod 校验）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { SCHEMA_VERSION, makeId, saveFlow } from '@rr/schema'
import type {
	Candidate,
	ElementRef,
	Expect,
	Flow,
	FrameAnchor,
	FramePath,
	FrameSegment,
	Step,
	Variable,
} from '@rr/schema'
import { chromium } from 'playwright'
import type { CDPSession, Frame, Locator, Page } from 'playwright'

import {
	clearUids,
	describeElement,
	EMPTY_DESCRIPTION,
	ensureCaptureInPage,
	installCapture,
	locateByUid,
	normalizeEmitPayload,
	readFactsByUid,
	readFactsFromHandle,
	screenshotRegion,
	snapshotPage,
	validateCandidates,
} from './capture-client.js'
/**
 * esbuild/tsx keepNames 垫片：页面内函数被 page.evaluate 序列化后，若函数体里带
 * `__name(...)` 调用，页面里没有该全局就会 ReferenceError。纯字符串，不经过编译。
 */
const NAME_KEEPALIVE_SOURCE = 'globalThis.__name = globalThis.__name || ((fn) => fn); true'
import { coalesceEvents } from './coalesce.js'
import { buildElementRef, deriveCandidates } from './element.js'
import { appearedNodes, inferExpect, pickExpectTarget, urlPattern } from './expect.js'
import {
	downloadFilenamePattern,
	findDownloadFor,
	HOVER_WAIT_MS,
	insertDialogs,
	isMeaningfulHover,
	pageIndexOf,
	uploadVariableName,
	withTabSwitches,
} from './plan.js'
import type {
	CoalescedAction,
	PageSignature,
	PlannedItem,
	RawEvent,
	RecordOptions,
	RecordResult,
	RecordedDialog,
	RecordedDownload,
	SignatureNode,
} from './types.js'

const RECORDER_NAME = '@rr/recorder'
const RECORDER_VERSION = '0.1.0'

const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const DEFAULT_BUFFER_MS = 500
const DEFAULT_SETTLE_SILENCE_MS = 300
/** 稳定判定：连续多少帧布局不变 */
const STABLE_FRAMES = 2
/** 稳定等待上限：页面永远在动也要往下走，绝不把录制卡死 */
const MAX_SETTLE_MS = 5000
/** 每多少毫秒检查一次 buffer 是否可以冲 */
const TICK_MS = 100
/** 动作进行中周期性采样页面签名（用于把 expect 正确归因到动作） */
const SIGNATURE_INTERVAL_MS = 120
/** hover 步骤推断 expect 时往前回看的窗口（覆盖 350ms 停留 + 采样抖动） */
const HOVER_LOOKBACK_MS = 600
/** 采样上限，防止长录制把内存吃掉 */
const MAX_SIGNATURE_SAMPLES = 600

export async function record(opts: RecordOptions): Promise<RecordResult> {
	const viewport = opts.viewport ?? DEFAULT_VIEWPORT
	const headless = opts.headless ?? false
	const bufferMs = opts.bufferMs ?? DEFAULT_BUFFER_MS
	const silenceMs = opts.settleSilenceMs ?? DEFAULT_SETTLE_SILENCE_MS
	const artifactsRoot = resolve(opts.artifactsRoot ?? './artifacts')
	const flowId = makeId('flow')
	const artifactsDir = join(artifactsRoot, flowId)
	const elementsDir = join(artifactsDir, 'record', 'elements')
	/** 懒创建：录制失败或 0 步时不该留下空目录 */
	let elementsDirReady = false
	const ensureElementsDir = async (): Promise<void> => {
		if (elementsDirReady) return
		await mkdir(elementsDir, { recursive: true })
		elementsDirReady = true
	}

	/* ---------------- 采集通道状态 ---------------- */

	const pending: RawEvent[] = []
	const allEvents: RawEvent[] = []
	const warnings: string[] = []
	let lastEventTs = Date.now()

	/** 标签页序号：按 Page 创建顺序，0 = 录制起点（任务要求 index=0 可省略） */
	const pageIndexes = new WeakMap<Page, number>()
	const pagesByIndex = new Map<number, Page>()
	let pageSeq = 0
	const ensurePageIndex = (target: Page): number => {
		const existing = pageIndexes.get(target)
		if (existing !== undefined) return existing
		const index = pageSeq++
		pageIndexes.set(target, index)
		pagesByIndex.set(index, target)
		return index
	}

	/** 录制期的旁路事件（不来自页面事件流）：原生对话框 / 下载 */
	const dialogs: RecordedDialog[] = []
	const downloads: RecordedDownload[] = []
	const consumedDialogs = new Set<RecordedDialog>()
	const consumedDownloads = new Set<RecordedDownload>()

	const frameIndexes = new WeakMap<Frame, number>()
	const framesByIndex = new Map<number, Frame>()
	let frameSeq = 0
	const ensureFrameIndex = (frame: Frame): number => {
		const existing = frameIndexes.get(frame)
		if (existing !== undefined) return existing
		const index = frameSeq++
		frameIndexes.set(frame, index)
		framesByIndex.set(index, frame)
		return index
	}

	/* ---------------- 录制产物状态 ---------------- */

	const steps: Step[] = []
	const variables = new Map<string, Variable>()
	let stepSeq = 0
	/** 上传文件占位变量序号：file_1 / file_2 … */
	let uploadSeq = 0
	/** 每个标签页最近一次签名（expect 推断的兜底 before） */
	const lastSigByPage = new Map<number, PageSignature>()
	/** 页面签名时间线：多标签页各自打点，按 pageIndex 过滤使用 */
	const samples: Array<{ ts: number; pageIndex: number; sig: PageSignature }> = []

	const browser = await chromium.launch({ headless })
	try {
		const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
		// keepNames 垫片：页面内采集/校验函数会经 page.evaluate 序列化，esbuild 注入的 __name 在页面里不存在
		await context.addInitScript({ content: NAME_KEEPALIVE_SOURCE })
		await installCapture(context, (sourcePage, frame, payload) => {
			const event = normalizeEmitPayload(payload)
			if (!event) return
			event.frameIndex = ensureFrameIndex(frame)
			// 多标签页归属：binding 回调的 source.page 才是可靠来源（frame 会跨页，页面内也看不到 tab 身份）
			event.pageIndex = ensurePageIndex(sourcePage)
			lastEventTs = event.ts
			pending.push(event)
			if (allEvents.length < 5000) allEvents.push(event)
		})

		/**
		 * 给每个标签页挂监听：
		 * - dialog：**必须立刻 accept**，否则原生弹窗把页面卡住、录制直接死；
		 *   同时记一条旁路事件，成步时插到触发它的那一步之后。
		 * - download：记下来给触发它的那一步补 `expect: {kind:'download'}`。
		 * - page：popup / target=_blank 新开的标签页，按创建顺序拿 index。
		 */
		const wiredPages = new WeakSet<Page>()
		const attachPageListeners = (target: Page): void => {
			// context.on('page') 对 context.newPage() 也会触发，必须去重：
			// 否则 dialog 会被 accept 两次、记录成两条 dialog 步骤（实测踩过）
			if (wiredPages.has(target)) return
			wiredPages.add(target)

			/**
			 * 兜底注入：popup 的首个真实文档拿不到 context 级 initScript（实测），
			 * 所以每个页面在「创建时 / domcontentloaded / 主 frame 导航后」各补一次。
			 * capture.js 用 document 级标记去重，重复调用是安全的。
			 */
			const installCapture = (): void => {
				void ensureCaptureInPage(target).catch(() => {})
			}
			installCapture()
			target.on('domcontentloaded', installCapture)
			target.on('framenavigated', (frame) => {
				if (frame === target.mainFrame()) installCapture()
			})

			target.on('dialog', (dialog) => {
				const pageIndex = ensurePageIndex(target)
				const type = dialog.type()
				const promptText = type === 'prompt' ? dialog.defaultValue() : undefined
				dialogs.push({ ts: Date.now(), pageIndex, action: 'accept', ...(promptText === undefined ? {} : { promptText }) })
				// accept(defaultValue)：让录制继续；prompt 的真实用户输入拿不到，只能记默认值
				void dialog.accept(promptText).catch(() => {})
				warnings.push(`录制期处理了原生 ${type} 对话框（已 accept）：${dialog.message().slice(0, 120)}`)
			})
			target.on('download', (download) => {
				downloads.push({
					ts: Date.now(),
					pageIndex: ensurePageIndex(target),
					filename: download.suggestedFilename(),
				})
			})
		}

		context.on('page', (opened) => {
			ensurePageIndex(opened)
			attachPageListeners(opened)
		})

		const page = await context.newPage()
		ensurePageIndex(page)
		attachPageListeners(page)
		await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
		await page.waitForLoadState('load').catch(() => {})

		const dpr = await page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1)
		const startUrl = page.url()
		const syncFrames = () => {
			for (const target of pagesByIndex.values()) {
				if (!target.isClosed()) for (const frame of target.frames()) ensureFrameIndex(frame)
			}
		}
		syncFrames()
		// 初始签名：第一个动作的「before」
		await settleFrameStability(page).catch(() => {})
		lastSigByPage.set(0, await snapshotPage(page, ensureFrameIndex))

		/* ---------- CDP：判断点击目标有没有 closed shadow root ----------
		 * Spike A 结论：closed shadow 内部对页面 JS / Playwright locator / aria 都不可见，
		 * 唯一可靠的判定是 CDP `DOM.describeNode(host).shadowRoots[].shadowRootType`。
		 * 命中时录制为「host 的 ElementRef + innerOffset」，回放用 host.click({position})。
		 */
		/** 每个标签页一份 CDP session（DOM 查询是 per-document 的） */
		const cdpByPage = new WeakMap<Page, { session: CDPSession; rootNodeId?: number }>()
		const ensureCdp = async (
			target: Page,
		): Promise<{ session: CDPSession; rootNodeId?: number }> => {
			let entry = cdpByPage.get(target)
			if (!entry) {
				const session = await context.newCDPSession(target)
				await session.send('DOM.enable')
				entry = { session }
				cdpByPage.set(target, entry)
			}
			return entry
		}
		const hasClosedShadowRoot = async (target: Page, uid: string): Promise<boolean> => {
			try {
				const entry = await ensureCdp(target)
				if (entry.rootNodeId === undefined) {
					const doc = await entry.session.send('DOM.getDocument', { depth: 0 })
					entry.rootNodeId = doc.root.nodeId
				}
				const { nodeId } = await entry.session.send('DOM.querySelector', {
					nodeId: entry.rootNodeId!,
					selector: `[data-rr-uid="${uid}"]`,
				})
				if (!nodeId) return false
				const described = await entry.session.send('DOM.describeNode', {
					nodeId,
					depth: 1,
					pierce: false,
				})
				const roots =
					(described.node as { shadowRoots?: Array<{ shadowRootType?: string }> }).shadowRoots ?? []
				return roots.some((root) => root.shadowRootType === 'closed')
			} catch {
				// 文档切换 / 节点消失：重置该页缓存，下次重试
				const entry = cdpByPage.get(target)
				if (entry) entry.rootNodeId = undefined
				return false
			}
		}

		/** 动作所属的页面（pageIndex 缺省 = 0，即录制起点页） */
		const pageOfAction = (action: CoalescedAction): Page =>
			pagesByIndex.get(pageIndexOf(action, 0)) ?? page

		/** 给 step 打标签页标记：index 0 可省略（回放默认从起点页开始） */
		const markPage = (step: Step, index: number): Step =>
			index > 0 ? ({ ...step, page: { index } } as Step) : step

		/* ---------- 单个动作 → Step ---------- */

		const buildRefFor = async (
			action: CoalescedAction,
			stepIndex: number,
		): Promise<ElementRef | undefined> => {
			const baseFacts = action.facts
			if (!baseFacts) return undefined
			const actionPage = pageOfAction(action)
			const frame = framesByIndex.get(action.frameIndex ?? 0) ?? actionPage.mainFrame()
			const uid = baseFacts.uid

			let facts = baseFacts
			let locator: Locator | undefined
			if (uid) {
				locator = await locateByUid(frame, uid)
				if (locator) {
					// 元素可能已经移动/属性变了：录完的「最新事实」才是回放时的样子
					const fresh = await readFactsByUid(frame, uid)
					if (fresh) facts = { ...fresh, uid }
				}
			}

			const described = locator ? await describeElement(locator).catch(() => EMPTY_DESCRIPTION) : {}
			const merged = {
				...facts,
				uid,
				role: described.role ?? baseFacts.role ?? facts.attributes['role'],
				accessibleName: described.name ?? baseFacts.accessibleName,
			}

			// closed shadow：目标实际是 host，内层元素既不可定位也不可快照，
			// 只能记 host + 相对 padding box 的偏移，回放靠 host.click({position})。
			if (action.kind === 'click' && uid) {
				const closed = await hasClosedShadowRoot(actionPage, uid)
				if (closed) {
					merged.shadowRootType = 'closed'
					if (action.offset)
						merged.innerOffset = { x: round2(action.offset.x), y: round2(action.offset.y) }
				}
			}

			const derived = deriveCandidates(merged)
			let accepted: Candidate[] = derived.slice(0, 4)
			let validation: 'ok' | 'detached' | 'ambiguous' | 'unvalidated' = 'detached'
			if (uid && locator) {
				const result = await validateCandidates(frame, derived, uid)
				if (result.accepted.length) {
					accepted = result.accepted
					validation = 'ok'
				} else {
					validation = 'ambiguous'
				}
			}

			// 元素裁剪图（crop.ref 相对 artifacts/<flowId>/）
			// 用非滚动截图（page.screenshot + clip）：不改变页面滚动/焦点，否则会录到"自己造成的滚动"
			let crop: ElementRef['crop']
			if (locator) {
				const ref = `record/elements/${stepIndex}.png`
				await ensureElementsDir()
				const shot = await screenshotRegion(
					actionPage,
					frame,
					merged.rect ?? facts.rect,
					merged.scroll ?? facts.scroll ?? { x: 0, y: 0 },
					join(elementsDir, `${stepIndex}.png`),
				)
				if (shot) {
					crop = { ref, dpr: facts.dpr ?? dpr }
				}
			}

			const elementRef = buildElementRef({
				...merged,
				candidates: accepted,
				frame: await buildFramePath(frame),
				crop,
			})
			if (validation !== 'ok') {
				const note =
					validation === 'detached'
						? '元素在录制后被销毁，候选未经校验'
						: '候选未能唯一命中，已保留启发式顺序'
				elementRef.description = `${elementRef.description ?? ''}（${note}）`.trim()
			}
			return elementRef
		}

		/**
		 * iframe 链（Spike 结论 2）：每一层都记 `frameElement` anchor + `urlPattern`，**不依赖 index**。
		 * - anchor：iframe 元素的语义身份（id/name/testid/role），跨 reload 稳定；
		 * - urlPattern：child frame 的 URL 形状，作为 anchor 失效时的第二道线索。
		 * 只有 url 是 about:blank 且拿不到 anchor 时才退化到 index。
		 */
		const buildFramePath = async (frame: Frame): Promise<FramePath> => {
			const chain: Frame[] = []
			let current: Frame | null = frame
			while (current && current.parentFrame()) {
				chain.unshift(current)
				current = current.parentFrame()
			}
			if (!chain.length) return { path: [] }
			const path: FrameSegment[] = []
			for (const child of chain) {
				const anchor = await buildFrameAnchor(child).catch(() => undefined)
				if (anchor) path.push({ kind: 'frameElement', anchor })
				const childUrl = child.url()
				if (childUrl && childUrl !== 'about:blank')
					path.push({ kind: 'urlPattern', pattern: urlPattern(childUrl) })
				if (!anchor && (!childUrl || childUrl === 'about:blank'))
					path.push({
						kind: 'index',
						index: child.parentFrame()?.childFrames().indexOf(child) ?? 0,
					})
			}
			return { path }
		}

		/**
		 * iframe 元素的 anchor：优先 id / name / testid 这类稳定身份。
		 * 复用普通元素的「打 uid → 采事实 → ariaSnapshot 取 role/name → locator 校验」链路。
		 */
		const buildFrameAnchor = async (childFrame: Frame): Promise<FrameAnchor | undefined> => {
			const parent = childFrame.parentFrame()
			if (!parent) return undefined
			const handle = await childFrame.frameElement().catch(() => null)
			if (!handle) return undefined
			try {
				const element = handle.asElement()
				if (!element) return undefined
				// 给 iframe 元素打一个临时标记，复用手普通元素完全相同的校验链路
				const uid = await element.evaluate((node) => {
					const el = node as Element
					const existing = el.getAttribute('data-rr-uid')
					if (existing) return existing
					const next = `frame_${Math.random().toString(36).slice(2, 8)}`
					el.setAttribute('data-rr-uid', next)
					return next
				})
				const facts = await readFactsFromHandle(element as any)
				if (!facts) return undefined
				const iframeLocator = parent.locator(`[data-rr-uid="${uid}"]`)
				const described = await describeElement(iframeLocator).catch(() => EMPTY_DESCRIPTION)
				const merged = { ...facts, uid, role: described.role, accessibleName: described.name }
				const derived = deriveCandidates(merged)
				const result = await validateCandidates(parent, derived, uid)
				const ref = buildElementRef({
					...merged,
					candidates: result.accepted.length ? result.accepted : derived.slice(0, 3),
				})
				return { observed: ref.observed, candidates: ref.candidates, fingerprint: ref.fingerprint }
			} finally {
				await handle.dispose().catch(() => {})
			}
		}

		/** 目标是不是 <input type=file>（回放用 setInputFiles，不用 click） */
		const isFileInput = (target: ElementRef): boolean => {
			if (target.observed.tag.toLowerCase() !== 'input') return false
			return (target.observed.attributes['type'] ?? '').toLowerCase() === 'file'
		}

		/**
		 * 上传步骤：只记「要传一个文件」，具体路径由回放时的变量提供。
		 *
		 * 为什么是占位变量：浏览器安全模型不把用户选的文件路径暴露给页面，
		 * 录制端拿不到（这是产品限制，不是实现偷懒）。同一次录制里第 N 个上传 → `file_N`。
		 */
		const buildUploadStep = (id: string, target: ElementRef): Step => {
			uploadSeq += 1
			const name = uploadVariableName(uploadSeq)
			variables.set(name, { name, type: 'file', secret: false, source: 'input' })
			return { kind: 'upload', id, target, files: [`{{${name}}}`] }
		}

		const buildStep = async (action: CoalescedAction): Promise<Step | undefined> => {
			const stepIndex = steps.length
			const id = `s${++stepSeq}`
			if (action.kind === 'navigate') {
				return { kind: 'navigate', id, url: action.url ?? pageOfAction(action).url() }
			}
			const target = await buildRefFor(action, stepIndex)
			switch (action.kind) {
				case 'click': {
					if (!target) return undefined
					// 点到 <input type=file> → 记 upload（占位变量），点本身没有回放价值：
					// 浏览器文件对话框在 Playwright 里根本打不开，回放靠 setInputFiles 填路径。
					if (isFileInput(target)) return buildUploadStep(id, target)
					const step: Step = {
						kind: 'click',
						id,
						target,
						button: action.button ?? 'left',
						clickCount: clamp(Math.round(action.clickCount ?? 1), 1, 3),
						modifiers: action.modifiers ?? [],
					}
					// closed shadow 必须带 position（schema 契约会强制检查），坐标是 CSS px
					if (target.observed.shadowRootType === 'closed' && target.observed.innerOffset)
						step.position = { ...target.observed.innerOffset }
					return step
				}
				case 'input': {
					if (!target) return undefined
					const type = target.observed.attributes['type']?.toLowerCase()
					if (action.masked || type === 'password') {
						variables.set('password', {
							name: 'password',
							type: 'secret',
							secret: true,
							source: 'input',
						})
						return { kind: 'input', id, target, value: '{{password}}', clear: true }
					}
					return { kind: 'input', id, target, value: action.value ?? '', clear: true }
				}
				case 'select': {
					if (!target) return undefined
					const values = action.selectedValues?.length
						? action.selectedValues
						: action.value !== undefined
							? [action.value]
							: []
					return {
						kind: 'select',
						id,
						target,
						value: values.length > 1 ? values : (values[0] ?? ''),
					}
				}
				case 'key': {
					const key = action.key ?? 'Enter'
					const modifiers = action.modifiers?.length ? action.modifiers : undefined
					if (!target) return { kind: 'key', id, key, ...(modifiers ? { modifiers } : {}) }
					return { kind: 'key', id, key, target, ...(modifiers ? { modifiers } : {}) }
				}
				case 'hover': {
					// hover 到这里时已经过意义过滤（aria-haspopup / 后面 2s 内点了别的元素）
					if (!target) return undefined
					return { kind: 'hover', id, target }
				}
				case 'scroll': {
					const delta = { x: Math.round(action.delta?.x ?? 0), y: Math.round(action.delta?.y ?? 0) }
					return target ? { kind: 'scroll', id, target, delta } : { kind: 'scroll', id, delta }
				}
				default:
					return undefined
			}
		}

		/* ---------- expect 推断：把「新出现的元素」变回 ElementRef ---------- */

		const takeExpect = async (
			before: PageSignature,
			after: PageSignature,
		): Promise<Expect | undefined> => {
			if (after.url !== before.url) return { kind: 'urlChange', pattern: urlPattern(after.url) }
			const appeared = appearedNodes(before, after)
			const picked = pickExpectTarget(appeared)
			if (!picked) return undefined
			const frame = framesByIndex.get(picked.frameIndex ?? 0)
			// 优先用 uid 把元素找回来做完整校验（候选可靠）；
			// 找不到（菜单已收起 / toast 已消失）就用快照里的事实兜底重建，
			// 否则「悬停展开的菜单」这种瞬时元素永远推不出 expect，回放时下一步必 HIDDEN。
			let ref = picked.uid && frame ? await buildRefFromUid(frame, picked.uid) : undefined
			if (!ref) ref = await buildRefFromSnapshotNode(picked, frame)
			if (!ref) return undefined
			picked.ref = ref
			// inferExpect 内部会重新挑一次（同输入同输出，必然仍选中 picked）
			return inferExpect(before, after)
		}

		const buildRefFromUid = async (frame: Frame, uid: string): Promise<ElementRef | undefined> => {
			const locator = await locateByUid(frame, uid)
			if (!locator) return undefined
			const facts = await readFactsByUid(frame, uid)
			if (!facts) return undefined
			const described = await describeElement(locator).catch(() => EMPTY_DESCRIPTION)
			const merged = { ...facts, uid, role: described.role, accessibleName: described.name }
			const derived = deriveCandidates(merged)
			const result = await validateCandidates(frame, derived, uid)
			return buildElementRef({
				...merged,
				candidates: result.accepted.length ? result.accepted : derived.slice(0, 3),
				frame: await buildFramePath(frame),
			})
		}

		/** 元素已消失时，用快照事实重建 ElementRef（候选未经 locator 校验，会带说明） */
		const buildRefFromSnapshotNode = async (
			node: SignatureNode,
			frame: Frame | undefined,
		): Promise<ElementRef | undefined> => {
			if (!node.attributes) return undefined
			const facts = {
				tag: node.tag,
				attributes: node.attributes,
				text: node.text || undefined,
				rect: node.rect,
				scroll: node.scroll ?? { x: 0, y: 0 },
				viewport: node.viewport ?? { width: 0, height: 0 },
				dpr: node.dpr ?? 1,
				recordedAt: Date.now(),
				nodePath: node.nodePath,
				role: node.role,
			}
			const derived = deriveCandidates(facts)
			const ref = buildElementRef({
				...facts,
				candidates: derived.slice(0, 3),
				frame: frame ? await buildFramePath(frame) : undefined,
			})
			ref.description = `${ref.description ?? ''}（元素在处理前已消失，候选未经实时校验）`.trim()
			return ref
		}

		/* ---------- 签名采样器 ----------
		 * 为什么需要它：drive 模式下一批动作可能在几十毫秒内全做完，等我们去 flush 时
		 * 页面早就到最终状态了。如果那时才抓 before/after，所有动作都会看到同一个「后」，
		 * expect 会被归因到错误的那一步（回放时必然误报）。
		 * 采样器按 120ms 打点，处理动作时按时间戳取「动作前最后一个点 / 动作后第一个点」。
		 */
		let sampling = false
		const sampleTimer = setInterval(() => {
			if (sampling) return
			sampling = true
			void (async () => {
				try {
					syncFrames()
					for (const [pageIndex, target] of pagesByIndex) {
						// 采样成本随标签页数量线性涨，超过 4 个就只采样前 4 个（expect 推断本来就是尽力而为）
						if (pageIndex > 3 || target.isClosed()) continue
						const sig = await snapshotPage(target, ensureFrameIndex)
						samples.push({ ts: Date.now(), pageIndex, sig })
					}
					while (samples.length > MAX_SIGNATURE_SAMPLES) samples.shift()
				} catch {
					/* 页面可能在导航，丢了这次采样 */
				} finally {
					sampling = false
				}
			})()
		}, SIGNATURE_INTERVAL_MS)

		/** 动作发生前最后一帧签名（只看这个标签页自己的采样） */
		const signatureBefore = (pageIndex: number, ts: number): PageSignature | undefined => {
			let best: PageSignature | undefined
			for (const sample of samples) {
				if (sample.pageIndex !== pageIndex) continue
				if (sample.ts <= ts) best = sample.sig
				else break
			}
			return best
		}

		/**
		 * 动作的「之后」= 下一个动作之前的最后一帧（同一标签页）。
		 *
		 * 为什么不用「ts + 固定延迟」：drive 模式下相邻动作只隔几毫秒，固定窗口会把后面的
		 * 变化（比如点提交后才出现的提示）算到前一步上，expect 归因错步、回放必然误报。
		 */
		const signatureAfter = (
			pageIndex: number,
			nextTs: number | undefined,
		): PageSignature | undefined => {
			let best: PageSignature | undefined
			for (const sample of samples) {
				if (sample.pageIndex !== pageIndex) continue
				if (nextTs !== undefined && sample.ts >= nextTs) break
				best = sample.sig
			}
			return best ?? lastSigByPage.get(pageIndex)
		}

		/* ---------- buffer 冲洗 ---------- */

		let flushChain: Promise<void> = Promise.resolve()
		const flush = (force: boolean): Promise<void> => {
			flushChain = flushChain.then(async () => {
				if (!pending.length) return
				if (!force && Date.now() - lastEventTs < bufferMs) return
				const batch = pending.splice(0, pending.length)
				try {
					await processBatch(batch)
				} catch (err) {
					warnings.push(`批次处理失败（${batch.length} 个事件）：${(err as Error).message}`)
				}
			})
			return flushChain
		}

		/** 跨批次状态：待定的 hover / 当前所在标签页 */
		const pendingHovers: CoalescedAction[] = []
		const tabState = { page: 0 }

		const nextTsOf = (items: PlannedItem[], index: number): number | undefined => {
			const next = items[index + 1]
			if (!next) return undefined
			return next.kind === 'action' ? next.action.ts : next.ts
		}

		/** 推入一条 step（带 page 标记 + onStep 回调；回调抛错不影响录制） */
		const pushStep = (step: Step, pageIndex: number): void => {
			const marked = markPage(step, pageIndex)
			steps.push(marked)
			if (!opts.onStep) return
			try {
				opts.onStep(marked)
			} catch (err) {
				warnings.push(`onStep 回调抛错：${(err as Error).message}`)
			}
		}

		const processBatch = async (batch: RawEvent[]): Promise<void> => {
			const actions = coalesceEvents(batch, { bufferMs })

			/* ---- 1. hover 意义过滤（要跨批次：hover 的「后续 click」可能落在下一批） ---- */
			const nonHover: CoalescedAction[] = []
			const batchHovers: CoalescedAction[] = []
			for (const action of actions) {
				if (action.kind === 'hover') batchHovers.push(action)
				else nonHover.push(action)
			}
			const hoverCandidates = [...pendingHovers, ...batchHovers].sort((a, b) => a.ts - b.ts)
			pendingHovers.length = 0
			const keptHovers: CoalescedAction[] = []
			for (const hover of hoverCandidates) {
				if (isMeaningfulHover(hover, nonHover)) {
					keptHovers.push(hover)
					continue
				}
				// 还没等到「悬停后点别的元素」就继续挂着；超时才判定为无声噪声丢弃
				if (Date.now() - hover.ts <= HOVER_WAIT_MS) pendingHovers.push(hover)
			}

			/* ---- 2. 纯函数规划：标签页切换 + 对话框插入 ---- */
			const merged = [...keptHovers, ...nonHover].sort((a, b) => a.ts - b.ts)
			const unconsumedDialogs = dialogs.filter((dialog) => !consumedDialogs.has(dialog))
			const planned = insertDialogs(withTabSwitches(merged, tabState), unconsumedDialogs)
			for (const dialog of planned.consumed) consumedDialogs.add(dialog)
			const items = planned.items

			/* ---- 3. 成步 ---- */
			for (let index = 0; index < items.length; index++) {
				const item = items[index]!
				const id = `s${++stepSeq}`

				if (item.kind === 'switchTab') {
					// 合成步骤：用户点的是浏览器标签栏，页面事件流里没有这条
					pushStep({ kind: 'switchTab', id, index: item.index }, item.pageIndex)
					continue
				}
				if (item.kind === 'dialog') {
					pushStep(
						{
							kind: 'dialog',
							id,
							action: item.action,
							...(item.promptText === undefined ? {} : { promptText: item.promptText }),
						},
						item.pageIndex,
					)
					continue
				}

				const action = item.action
				if (action.kind === 'unknown') continue
				const pageIndex = pageIndexOf(action, tabState.page)
				const actionPage = pageOfAction(action)

				// 动作后稳定点：布局不再跳 + 事件流静默（只影响「什么时候算录完」，不影响归因）
				await settleFrameStability(actionPage).catch(() => {})
				await waitForSilence(() => lastEventTs, silenceMs)
				syncFrames()

				const step = await buildStep(action)
				if (!step) continue

				// expect：只在同一标签页内比较签名（跨页比较会误判成 urlChange）
				//
				// hover 要往前多看 600ms：hover 事件是在「停留满 350ms」之后才上报的，
				// 而菜单是 mouseenter 瞬间就展开的 —— 只看 hover.ts 之后会得到「什么都没发生」，
				// 悬停展开的菜单就不会被记成 elementVisible，回放时下一步点菜单项必然 HIDDEN。
				const lookbackMs = action.kind === 'hover' ? HOVER_LOOKBACK_MS : 0
				const before =
					signatureBefore(pageIndex, action.ts - lookbackMs) ?? lastSigByPage.get(pageIndex)
				const after = signatureAfter(pageIndex, nextTsOf(items, index))
				if (before && after) {
					const inferred = await takeExpect(before, after)
					if (inferred) step.expect = inferred
				}
				if (!step.expect && action.expectUrl)
					step.expect = { kind: 'urlChange', pattern: urlPattern(action.expectUrl) }

				// 下载是「明确的副作用」，优先级高于推断出来的 expect
				const download = findDownloadFor(
					action,
					downloads,
					consumedDownloads,
					nextTsOf(items, index),
				)
				if (download) {
					consumedDownloads.add(download)
					step.expect = { kind: 'download', filenamePattern: downloadFilenamePattern(download.filename) }
				}

				if (after) lastSigByPage.set(pageIndex, after)
				pushStep(step, pageIndex)
			}
		}

		/* ---------- 开始录制 ---------- */

		let resolveStop: (() => void) | undefined
		const stopPromise = new Promise<void>((done) => {
			resolveStop = done
		})
		let stopped = false
		const stop = () => {
			if (stopped) return
			stopped = true
			resolveStop?.()
		}
		const onAbort = () => stop()
		opts.stopSignal?.addEventListener('abort', onAbort, { once: true })
		let onSigint: (() => void) | undefined
		let savedSigintListeners: NodeJS.SignalsListener[] = []
		if (!opts.drive) {
			// 人工录制：Ctrl+C 收尾（drive 模式下不接管信号，避免和测试进程抢）
			//
			// 注意：Playwright 自己的 SIGINT handler 会直接 `process.exit(130)`，
			// 抢在我们的收尾（落盘）之前。所以录制期间临时接管 SIGINT，
			// 结束时把原来的监听器原样装回去，不影响宿主程序后续行为。
			savedSigintListeners = process.listeners('SIGINT')
			process.removeAllListeners('SIGINT')
			onSigint = () => stop()
			process.on('SIGINT', onSigint)
		}

		const ticker = setInterval(() => {
			void flush(false)
		}, TICK_MS)

		let driveError: Error | undefined
		try {
			if (opts.drive) {
				try {
					await opts.drive(page, stop)
				} catch (err) {
					// drive 抛错必须也走收尾流程，否则 stopPromise 永远不 resolve（录制挂死）
					driveError = err as Error
					warnings.push(`drive 失败：${(err as Error).message}`)
				}
				stop()
			}
			await stopPromise
		} finally {
			clearInterval(ticker)
			if (onSigint) {
				process.off('SIGINT', onSigint)
				for (const listener of savedSigintListeners) process.on('SIGINT', listener)
			}
			opts.stopSignal?.removeEventListener('abort', onAbort)
		}

		// 收尾：给最后的驱动动作一点时间把事件送到，然后强制冲掉
		await sleep(Math.min(silenceMs, 400))
		await flush(true)
		await flushChain
		// 采样器要活到最后一个动作处理完：最后一个动作的「之后」就是它提供的最新一帧
		clearInterval(sampleTimer)

		// 收尾 flush 之后仍没被消费的旁路事件：
		// - 对话框：补成末尾步骤（否则回放时会卡在一个没人处理的 dialog 上）
		// - 下载：挂到最后一步的 expect（常见于「点导出 → 立刻下载」）
		for (const dialog of dialogs) {
			if (consumedDialogs.has(dialog)) continue
			consumedDialogs.add(dialog)
			pushStep(
				{
					kind: 'dialog',
					id: `s${++stepSeq}`,
					action: dialog.action,
					...(dialog.promptText === undefined ? {} : { promptText: dialog.promptText }),
				},
				dialog.pageIndex,
			)
		}
		const leftoverDownload = downloads.find((download) => !consumedDownloads.has(download))
		if (leftoverDownload && steps.length) {
			consumedDownloads.add(leftoverDownload)
			const last = steps[steps.length - 1]!
			if (!last.expect)
				last.expect = {
					kind: 'download',
					filenamePattern: downloadFilenamePattern(leftoverDownload.filename),
				}
		}
		// pendingHovers 到最后仍没等到 click → 就是鼠标划过的噪声，直接丢弃（不告警）

		// uid 标记只服务于录制期的候选校验：所有步骤都建好之后再统一清掉（多标签页逐页清）
		for (const target of pagesByIndex.values()) {
			if (target.isClosed()) continue
			await clearUids(target).catch(() => {})
		}

		/* ---------- 步骤后处理 ---------- */
		// 1) 同一目标连续 input 合并成最后一次（人工输入停顿 >500ms 会被拆成多步）
		// 2) 可编辑元素上的 click 紧跟同目标 input/select 时，丢掉 click（input 自带聚焦）
		const refinedSteps = refineSteps(steps)
		steps.length = 0
		// id 连续化：中途可能有步骤被丢弃（去噪/detached），保证 s1..sN 连续好读
		steps.push(...refinedSteps.map((step, index) => ({ ...step, id: `s${index + 1}` }) as Step))

		/* ---------- 落盘 ---------- */

		if (driveError) {
			// 半截录制不落盘：调用方要的是完整可回放的 flow，不是错位的半截
			throw new Error(
				`drive 回调失败，录制中止（已采集 ${steps.length} 步，未写盘）：${driveError.message}`,
			)
		}
		if (!steps.length) {
			throw new Error(
				'未采集到任何可回放的动作：录制期间没有发生交互（检查 drive/stopSignal 是否会触发，以及页面是否真的接收了事件）',
			)
		}

		const flow: Flow = {
			schemaVersion: SCHEMA_VERSION,
			id: flowId,
			title: opts.title ?? titleFromUrl(startUrl),
			version: 1,
			createdAt: new Date().toISOString(),
			meta: {
				env: {
					startUrl,
					viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
					dpr,
				},
				recorder: { name: RECORDER_NAME, version: RECORDER_VERSION },
			},
			variables: [...variables.values()],
			steps,
			selfHealed: [],
		}

		let rawPath: string | undefined
		if (opts.keepRaw) {
			rawPath = join(dirname(opts.outPath), `${basename(opts.outPath, '.json')}.raw.json`)
			await mkdir(dirname(rawPath), { recursive: true })
			await writeFile(
				rawPath,
				`${JSON.stringify(
					{
						startUrl,
						viewport,
						dpr,
						warnings,
						pages: [...pagesByIndex].map(([index, target]) => ({ index, url: target.url() })),
						dialogs,
						downloads,
						events: allEvents,
					},
					null,
					2,
				)}\n`,
				'utf8',
			)
		}

		// 写前 zod + 契约校验（非法 IR 绝不落盘）
		await saveFlow(flow, opts.outPath)
		return { flow, artifactsDir, rawPath }
	} finally {
		await browser.close().catch(() => {})
	}
}

/* ------------------------------------------------------------------ */
/* 稳定点 / 静默                                                       */
/* ------------------------------------------------------------------ */

/** 连续 N 帧「布局指纹」不变才算稳定（对应架构里的「连续 2 帧无布局变化」） */
async function settleFrameStability(page: Page): Promise<void> {
	await page
		.evaluate(
			(frames) =>
				new Promise<void>((resolve) => {
					const doc = document.documentElement
					const measure = () =>
						`${doc.scrollWidth}x${doc.scrollHeight}x${document.querySelectorAll('*').length}`
					let last = measure()
					let stable = 0
					let guard = 0
					const tick = () => {
						if (++guard > 120) return resolve()
						const current = measure()
						if (current === last) {
							if (++stable >= frames) return resolve()
						} else {
							stable = 0
							last = current
						}
						requestAnimationFrame(tick)
					}
					requestAnimationFrame(tick)
				}),
			STABLE_FRAMES,
		)
		.catch(() => {
			/* 页面在导航：稳定性检查跳过 */
		})
}

/** 事件流静默：距最后一个事件 ≥ silenceMs（有上限，不卡死） */
async function waitForSilence(getLastEventTs: () => number, silenceMs: number): Promise<void> {
	const started = Date.now()
	while (Date.now() - started < MAX_SETTLE_MS) {
		if (Date.now() - getLastEventTs() >= silenceMs) return
		await sleep(40)
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms))
}

/** 坐标保留 2 位小数（CSS px，不乘 dpr） */
function round2(value: number): number {
	return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

function titleFromUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl)
		return url.pathname && url.pathname !== '/' ? url.pathname : url.hostname
	} catch {
		return rawUrl
	}
}

/** 录制后步骤清理：合并碎片化的输入、去掉可编辑元素上多余的 click */
function refineSteps(steps: Step[]): Step[] {
	const keyOf = (step: Step): string | undefined => {
		if (!('target' in step) || !step.target) return undefined
		const ref = step.target as ElementRef
		return `${ref.fingerprint.stableHash}|${JSON.stringify(ref.frame?.path ?? [])}|${step.page?.index ?? 0}`
	}
	const isEditable = (step: Step): boolean => {
		if (!('target' in step) || !step.target) return false
		const ref = step.target as ElementRef
		const tag = ref.observed.tag
		return (
			tag === 'input' ||
			tag === 'textarea' ||
			tag === 'select' ||
			ref.observed.attributes?.['contenteditable'] === 'true'
		)
	}
	const out: Step[] = []
	for (const step of steps) {
		const prev = out[out.length - 1]
		const prevKey = prev ? keyOf(prev) : undefined
		const curKey = keyOf(step)
		// 连续 input（同目标）→ 保留最后一次，沿用第一条的 id（时间线稳定）
		if (step.kind === 'input' && prev?.kind === 'input' && prevKey && prevKey === curKey) {
			out[out.length - 1] = { ...step, id: prev.id }
			continue
		}
		// 可编辑元素上的 click 紧跟同目标 input/select → 丢掉 click
		if (
			prev?.kind === 'click' &&
			isEditable(prev) &&
			prevKey === curKey &&
			(step.kind === 'input' || step.kind === 'select')
		) {
			out[out.length - 1] = step
			continue
		}
		out.push(step)
	}
	return out
}
