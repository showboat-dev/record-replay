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
import type {
	CoalescedAction,
	PageSignature,
	RawEvent,
	RecordOptions,
	RecordResult,
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
	let prevSig: PageSignature | undefined
	/** 录制期间的页面签名时间线：`{ts, sig}`，用来把 expect 归因到正确的动作 */
	const samples: Array<{ ts: number; sig: PageSignature }> = []

	const browser = await chromium.launch({ headless })
	try {
		const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
		// keepNames 垫片：页面内采集/校验函数会经 page.evaluate 序列化，esbuild 注入的 __name 在页面里不存在
		await context.addInitScript({ content: NAME_KEEPALIVE_SOURCE })
		await installCapture(context, (frame, payload) => {
			const event = normalizeEmitPayload(payload)
			if (!event) return
			event.frameIndex = ensureFrameIndex(frame)
			lastEventTs = event.ts
			pending.push(event)
			if (allEvents.length < 5000) allEvents.push(event)
		})

		const page = await context.newPage()
		await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
		await page.waitForLoadState('load').catch(() => {})

		const dpr = await page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1)
		const startUrl = page.url()
		const syncFrames = () => {
			for (const frame of page.frames()) ensureFrameIndex(frame)
		}
		syncFrames()
		// 初始签名：第一个动作的「before」
		await settleFrameStability(page).catch(() => {})
		prevSig = await snapshotPage(page)

		/* ---------- CDP：判断点击目标有没有 closed shadow root ----------
		 * Spike A 结论：closed shadow 内部对页面 JS / Playwright locator / aria 都不可见，
		 * 唯一可靠的判定是 CDP `DOM.describeNode(host).shadowRoots[].shadowRootType`。
		 * 命中时录制为「host 的 ElementRef + innerOffset」，回放用 host.click({position})。
		 */
		let cdpSession: CDPSession | undefined
		let cdpRootNodeId: number | undefined
		const ensureCdp = async (): Promise<CDPSession> => {
			if (!cdpSession) {
				cdpSession = await context.newCDPSession(page)
				await cdpSession.send('DOM.enable')
			}
			return cdpSession
		}
		const hasClosedShadowRoot = async (uid: string): Promise<boolean> => {
			try {
				const session = await ensureCdp()
				if (cdpRootNodeId === undefined) {
					const doc = await session.send('DOM.getDocument', { depth: 0 })
					cdpRootNodeId = doc.root.nodeId
				}
				const { nodeId } = await session.send('DOM.querySelector', {
					nodeId: cdpRootNodeId!,
					selector: `[data-rr-uid="${uid}"]`,
				})
				if (!nodeId) return false
				const described = await session.send('DOM.describeNode', {
					nodeId,
					depth: 1,
					pierce: false,
				})
				const roots =
					(described.node as { shadowRoots?: Array<{ shadowRootType?: string }> }).shadowRoots ?? []
				return roots.some((root) => root.shadowRootType === 'closed')
			} catch {
				// 文档切换 / 节点消失：重置缓存，下次重试
				cdpRootNodeId = undefined
				return false
			}
		}

		/* ---------- 单个动作 → Step ---------- */

		const buildRefFor = async (
			action: CoalescedAction,
			stepIndex: number,
		): Promise<ElementRef | undefined> => {
			const baseFacts = action.facts
			if (!baseFacts) return undefined
			const frame = framesByIndex.get(action.frameIndex ?? 0) ?? page.mainFrame()
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
				const closed = await hasClosedShadowRoot(uid)
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
					page,
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

		const buildStep = async (action: CoalescedAction): Promise<Step | undefined> => {
			const stepIndex = steps.length
			const id = `s${++stepSeq}`
			if (action.kind === 'navigate') {
				return { kind: 'navigate', id, url: action.url ?? page.url() }
			}
			const target = await buildRefFor(action, stepIndex)
			switch (action.kind) {
				case 'click': {
					if (!target) return undefined
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
					return target ? { kind: 'key', id, key, target } : { kind: 'key', id, key }
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
			if (!picked?.uid) return undefined
			const frame = framesByIndex.get(picked.frameIndex ?? 0)
			if (!frame) return undefined
			const ref = await buildRefFromUid(frame, picked.uid)
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
					const sig = await snapshotPage(page)
					samples.push({ ts: Date.now(), sig })
					if (samples.length > MAX_SIGNATURE_SAMPLES) samples.shift()
				} catch {
					/* 页面可能在导航，丢了这次采样 */
				} finally {
					sampling = false
				}
			})()
		}, SIGNATURE_INTERVAL_MS)

		/** 动作发生前最后一帧签名 */
		const signatureBefore = (ts: number): PageSignature | undefined => {
			let best: PageSignature | undefined
			for (const sample of samples) {
				if (sample.ts <= ts) best = sample.sig
				else break
			}
			return best
		}

		/**
		 * 动作 i 的「之后」= 下一个动作发生之前的最后一帧。
		 *
		 * 为什么不用「ts + 固定延迟」：drive 模式下相邻动作只隔几毫秒，
		 * 固定延迟窗口会把后面的变化（比如点击提交后才出现的提示）算到前面的动作上，
		 * 导致 expect 归因错步、回放必然误报。用「下一个动作之前」既有明确语义，
		 * 也不依赖动作有多快。
		 */
		const signatureAfterAction = (
			actions: CoalescedAction[],
			index: number,
		): PageSignature | undefined => {
			const next = actions[index + 1]
			if (next) {
				let best: PageSignature | undefined
				for (const sample of samples) {
					if (sample.ts < next.ts) best = sample.sig
					else break
				}
				return best
			}
			// 批内最后一个动作：取当前最新采样（此时已经过「静默 + 稳定」窗口）
			return samples[samples.length - 1]?.sig
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

		const processBatch = async (batch: RawEvent[]): Promise<void> => {
			const actions = coalesceEvents(batch, { bufferMs })
			for (let index = 0; index < actions.length; index++) {
				const action = actions[index]!
				if (action.kind === 'unknown' || action.kind === 'hover') continue
				// 动作后稳定点：布局不再跳 + 事件流静默（只影响「什么时候算录完」，不影响归因）
				await settleFrameStability(page).catch(() => {})
				await waitForSilence(() => lastEventTs, silenceMs)
				syncFrames()
				const step = await buildStep(action)
				if (!step) continue
				const before = signatureBefore(action.ts) ?? prevSig
				const after = signatureAfterAction(actions, index)
				if (before && after) {
					const inferred = await takeExpect(before, after)
					if (inferred) step.expect = inferred
				}
				if (!step.expect && action.expectUrl)
					step.expect = { kind: 'urlChange', pattern: urlPattern(action.expectUrl) }
				if (after) prevSig = after
				steps.push(step)
				if (opts.onStep) {
					try {
						opts.onStep(step)
					} catch (err) {
						warnings.push(`onStep 回调抛错：${(err as Error).message}`)
					}
				}
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
		// uid 标记只服务于录制期的候选校验：所有步骤都建好之后再统一清掉
		await clearUids(page).catch(() => {})

		/* ---------- 步骤后处理 ---------- */
		// 1) 同一目标连续 input 合并成最后一次（人工输入停顿 >500ms 会被拆成多步）
		// 2) 可编辑元素上的 click 紧跟同目标 input/select 时，丢掉 click（input 自带聚焦）
		const refinedSteps = refineSteps(steps)
		steps.length = 0
		steps.push(...refinedSteps)

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
				`${JSON.stringify({ startUrl, viewport, dpr, warnings, events: allEvents }, null, 2)}\n`,
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
		return `${ref.fingerprint.stableHash}|${JSON.stringify(ref.frame?.path ?? [])}`
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
