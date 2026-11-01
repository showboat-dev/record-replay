/**
 * 单次 run 的执行内核：逐步 resolve → act → verify，并产出 StepResult / artifact / 自愈记录。
 *
 * 失败一律走 classifyError 落语义错误码，绝不把裸 timeout 抛给上层；
 * artifact 只在失败（或 screenshotMode='all'）时落盘，避免每步都写磁盘。
 */
import { chromium, type Locator, type Page } from 'playwright'

import type { ElementRef, Flow } from '@rr/schema'
import { makeId } from '@rr/schema'
import { resolve, type ResolveResult } from '@rr/resolver'

import { runAction, type ActionDeps } from './actions.js'
import { ArtifactWriter } from './artifacts.js'
import { classifyError, StepFailure, type FailurePhase } from './errors.js'
import {
	describeCandidateForLog,
	pickCandidateFromFacts,
	type ElementFacts,
	type HealInput,
} from './selfheal.js'
import { DialogManager, type DialogMode } from './dialogs.js'
import { DownloadManager } from './downloads.js'
import { flattenSteps, hasStepKind } from './steps.js'
import { PageManager, resolveStepPageIndex } from './tabs.js'
import { defaultVariables, renderStep } from './template.js'
import { NAME_KEEPALIVE_SOURCE, rebaseUrl } from './url.js'
import { runAssertion, sleep, verifyExpect, type VerifyDeps } from './verify.js'
import type {
	PlayOptions,
	RunReport,
	RunResult,
	SelfHealRecord,
	StepDetail,
	StepResult,
} from './types.js'

export interface RunOutcome {
	result: RunResult
	report: RunReport
	/** 需要写回的自愈记录（含现场推出的候选） */
	heals: HealInput[]
}

/** 页面内取元素事实（给自愈写回生成候选用） */
function factsOf(el: Element): ElementFacts {
	const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
	const ariaLabel = el.getAttribute('aria-label') ?? undefined
	return {
		tag: el.tagName.toLowerCase(),
		id: el.getAttribute('id') ?? undefined,
		testid:
			el.getAttribute('data-testid') ??
			el.getAttribute('data-test') ??
			el.getAttribute('data-cy') ??
			undefined,
		role: el.getAttribute('role') ?? undefined,
		accessibleName: ariaLabel ?? (text.length > 0 ? text : undefined),
		nameAttr: el.getAttribute('name') ?? undefined,
		text,
		ariaLabel,
		placeholder: el.getAttribute('placeholder') ?? undefined,
	}
}

/** 页面快速快照（失败 artifact 用；不含大段 HTML，避免 artifact 爆掉） */
async function captureSnapshot(page: Page): Promise<unknown> {
	const base = await page
		.evaluate(() => ({
			url: location.href,
			title: document.title,
			viewport: { width: window.innerWidth, height: window.innerHeight },
			scroll: { x: window.scrollX, y: window.scrollY },
			activeElement: document.activeElement ? document.activeElement.tagName : null,
			text: (document.body ? document.body.innerText : '').slice(0, 4_000),
		}))
		.catch(() => ({ url: page.url(), title: '', viewport: null, scroll: null, text: '' }))
	let ariaSnapshot = ''
	try {
		ariaSnapshot = (await page.ariaSnapshot({ mode: 'ai' })).slice(0, 20_000)
	} catch {
		/* 页面已崩溃/关闭时忽略 */
	}
	return { ...base, ariaSnapshot }
}

async function armMutationProbe(page: Page): Promise<void> {
	await page
		.evaluate(() => {
			const w = window as unknown as {
				__rrProbe?: { disconnect: () => void }
				__rrMut?: number
			}
			if (w.__rrProbe) w.__rrProbe.disconnect()
			w.__rrMut = 0
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					// L2 打的临时标记不算"页面有变化"
					if (record.type === 'attributes') {
						const name = record.attributeName ?? ''
						if (name.startsWith('data-rr-')) continue
					}
					w.__rrMut = (w.__rrMut ?? 0) + 1
				}
			})
			observer.observe(document, {
				subtree: true,
				childList: true,
				attributes: true,
				characterData: true,
			})
			w.__rrProbe = observer
		})
		.catch(() => {
			/* 页面还没 ready 时忽略，NO_EFFECT 探测退化为只看 url */
		})
}

/**
 * 活动元素签名。
 * 用途：点击可聚焦元素会引起 focus ring 重绘（像素变了但产品上"什么都没发生"），
 * 所以 NO_EFFECT 判定要把"焦点变化"单独识别出来，否则所有按钮点击都会被误判成 NO_EFFECT。
 */
async function activeElementSig(page: Page): Promise<string> {
	return page
		.evaluate(() => {
			const el = document.activeElement
			if (!el) return ''
			const html = el as HTMLElement
			return `${el.tagName}#${html.id ?? ''}`
		})
		.catch(() => '')
}

function dialogManagerHistoryChanged(before: number, after: number): boolean {
	return after > before
}

/**
 * 给"可能被原生对话框阻塞"的页面操作加超时上限。
 * 页面 JS 被 alert/confirm 阻塞时，`evaluate`/`screenshot` 会一直等到 Playwright 超时，
 * 让整个 run 看起来像卡死；这里用 race 兜住，超时返回 fallback 由调用方决定怎么处理。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([promise, sleep(ms).then(() => fallback)])
}

async function readMutationCount(page: Page): Promise<number> {
	return page
		.evaluate(() => {
			const w = window as unknown as { __rrMut?: number }
			return w.__rrMut ?? 0
		})
		.catch(() => 0)
}

/**
 * 给目标元素加一圈临时高亮，让业务人员看得见"现在要操作哪里"。
 * 用 elementHandle.evaluate，iframe 内元素也生效（在所属文档里加 outline）。
 */
async function flashLocator(locator: Locator, delayMs: number): Promise<void> {
	const handle = await locator.elementHandle({ timeout: 1500 }).catch(() => null)
	if (!handle) {
		await sleep(delayMs)
		return
	}
	const paint = (color: string | null) =>
		handle
			.evaluate((el: Element, c: string | null) => {
				const style = (el as HTMLElement).style
				if (c) {
					style.outline = `3px solid ${c}`
					style.outlineOffset = '2px'
				} else {
					style.outline = ''
					style.outlineOffset = ''
				}
			}, color)
			.catch(() => undefined)
	await paint('#ff6b00')
	await sleep(delayMs)
	await paint(null)
	await handle.dispose().catch(() => undefined)
}

export async function executeRun(
	opts: PlayOptions,
	runId: string = makeId('run'),
): Promise<RunOutcome> {
	const flow: Flow = opts.flow
	const timeoutMs = opts.timeoutMs ?? 15_000
	const screenshotMode = opts.screenshotMode ?? 'failures'
	const artifacts = new ArtifactWriter(opts.artifactsRoot ?? './artifacts', flow.id, runId)
	const startedAt = new Date().toISOString()
	const runStart = Date.now()

	const vars: Record<string, string> = {
		...defaultVariables(flow.variables),
		...(opts.variables ?? {}),
	}

	const steps: StepResult[] = []
	const details: StepDetail[] = []
	const heals: HealInput[] = []
	const log = (msg: string): void => {
		opts.onLog?.(msg)
	}

	const logLines: string[] = []
	const pushLog = (msg: string): void => {
		logLines.push(msg)
		log(`[${flow.id}] ${msg}`)
	}

	// ---- 对话框策略：flow 里有 dialog 步骤 → 手动模式（只暂存，等 dialog 步骤处理） ----
	// 否则按 dialogPolicy：dismiss=auto（出现即关）、fail（出现即失败）
	const manualDialogs = hasStepKind(flow.steps, 'dialog')
	const dialogMode: DialogMode = manualDialogs
		? 'manual'
		: opts.dialogPolicy === 'fail'
			? 'fail'
			: 'auto'
	const dialogManager = new DialogManager(dialogMode, pushLog)
	if (manualDialogs) pushLog('flow 含 dialog 步骤 → 原生对话框改为手动处理模式')
	else if (dialogMode === 'fail') pushLog('dialogPolicy=fail：出现原生对话框即判该步失败')

	// ---- 下载 / 当前 step 归因 ----
	const stepIndexRef = { current: -1 }
	const downloads = new DownloadManager(artifacts, pushLog, {
		stepIndex: () => stepIndexRef.current,
	})
	// expect.download 只看"这一步开始之后"的下载
	const downloadCursor = { current: 0 }
	let observedPageCount = 1

	const browser = await chromium.launch({ headless: opts.headless ?? true })
	let browserCrashed = false

	try {
		const env = flow.meta.env
		const context = await browser.newContext({
			viewport: { width: env.viewport.width, height: env.viewport.height },
			deviceScaleFactor: env.dpr,
			...(env.locale ? { locale: env.locale } : {}),
			...(env.timezone ? { timezoneId: env.timezone } : {}),
			...(env.userAgent ? { userAgent: env.userAgent } : {}),
		})
		// keepNames 垫片：resolver/executor 里有函数被 page.evaluate 序列化进页面，
		// esbuild/tsx 注入的 __name(...) 在页面里不存在会导致 ReferenceError（真实站点 L2 挂掉的根因）
		await context.addInitScript({ content: NAME_KEEPALIVE_SOURCE })
		await context.newPage()
		// 多标签页：index 0 = 起点页，之后按创建顺序追加（与录制端一致）
		const pages = new PageManager(context, pushLog)
		let page: Page = pages.current()

		// 每个页都要：默认超时 / 对话框 handler / 崩溃监听（新标签页同样生效）
		const wirePage = (target: Page): void => {
			target.setDefaultTimeout(timeoutMs)
			target.on('dialog', (dialog) => dialogManager.handle(target, dialog))
			target.on('crash', () => {
				browserCrashed = true
				const index = pages.slots.find((slot) => slot.page === target)?.index ?? '?'
				pushLog(`页面崩溃（page.on("crash")，标签页 ${index}）`)
			})
		}
		for (const slot of pages.slots) wirePage(slot.page)
		context.on('page', wirePage)
		// 下载事件挂在 context 上：任何标签页触发的下载都能收到
		downloads.attach(context)
		pushLog(`起始标签页 ${pages.currentIndex}；对话框模式=${dialogMode}`)

		// ---- AI 修复适配器（默认关闭；opts.ai 为 null/undefined 时完全不注入） ----
		//
		// spike B 的 3 条硬约束（docs/spikes.md: B.3 / B.4 / B.7）：
		// 1) 自始至终只用 `ariaSnapshot({ mode: 'ai' })`：一次 default 模式快照会让主 frame 的 ref 静默失效；
		// 2) `getByRef(ref)` 之后**立刻** `.normalize()`，拿到带 contentFrame() 链的可复用 Locator 再 act；
		// 3) 导航后旧 ref 会抛 `Invalid frame in aria-ref selector` → 重新快照 + 重新 locate，判为可重试（最多 1 次）；
		// 另外：拿到 ref 与使用之间**不得再调用任何 ariaSnapshot**（包括 default 模式）。
		const pendingRepairRef: {
			current: { facts: ElementFacts; confidence: number; reason: string } | null
		} = { current: null }
		const aiClient = opts.ai
		const repair = aiClient
			? async (target: ElementRef, reason: string): Promise<Locator | null> => {
					pendingRepairRef.current = null

					for (let attempt = 0; attempt < 2; attempt++) {
						let ariaSnapshot = ''
						try {
							// 只允许 ai 模式（default 模式会让主 frame 的 ref 全部失效）
							ariaSnapshot = await page.ariaSnapshot({ mode: 'ai' })
						} catch {
							/* 忽略：AI 仍可能仅凭 target 给出 ref */
						}
						const output = await aiClient.locate({
							url: page.url(),
							target,
							ariaSnapshot: ariaSnapshot.slice(0, 8_000),
							candidates: target.candidates,
						})
						if (!output || !output.ref) {
							pushLog(`AI 未能给出定位（reason=${reason.slice(0, 120)}）`)
							return null
						}

						try {
							// getByRef → 立刻 normalize：normalize 产出带 contentFrame() 链的可复用 Locator
							const locator = await page.getByRef(output.ref).normalize()
							// 取元素事实只是普通 evaluate，不产生 aria 快照，不会让 ref 失效
							let facts: ElementFacts | undefined
							try {
								facts = await locator.evaluate(factsOf)
							} catch {
								facts = undefined
							}
							if (facts) {
								pendingRepairRef.current = {
									facts,
									confidence: output.confidence,
									reason: output.reason,
								}
							}
							pushLog(
								`AI 给出 ref=${output.ref} → normalize → ${locator.toString().slice(0, 120)}` +
									`（confidence=${output.confidence}）`,
							)
							return locator
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err)
							// 导航/刷新后旧 ref 的明确报错：可重试（重新快照 + 重新 locate）
							if (attempt === 0 && /Invalid frame in aria-ref selector/i.test(message)) {
								pushLog('AI ref 已因导航失效（Invalid frame in aria-ref selector），重新快照重试')
								continue
							}
							throw err
						}
					}
					return null
				}
			: undefined

		const resolveTarget = async (
			target: ElementRef,
			opts2: { requireVisible?: boolean; allowAi?: boolean; flash?: boolean } = {},
		): Promise<ResolveResult> => {
			// spike A / lead 约束 4：closed shadow 目标不要走 AI —— aria snapshot 里根本没有它，
			// 只可能白白消耗调用额度；直接按 host + position 降级。
			const closedShadow = target.observed.shadowRootType === 'closed'
			if (closedShadow && opts2.allowAi !== false) {
				pushLog('closed shadow 目标：跳过 AI，走 host + position 降级（spike A）')
			}
			const allowAi = opts2.allowAi ?? true
			const result = await resolve(target, {
				page,
				...(allowAi && !closedShadow && repair ? { repair } : {}),
				log: (msg) => pushLog(`  resolve: ${msg}`),
				options: {
					requireVisible: opts2.requireVisible ?? true,
					allowAi: allowAi && !closedShadow,
					// iframe 的 urlPattern 段也要按回放环境重定基（录制 5199 / 回放 5173）
					...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
					// 元素出现等待预算（默认交给 resolver 的 5000ms）
					...(opts.elementWaitMs !== undefined ? { elementWaitMs: opts.elementWaitMs } : {}),
				},
			})
			// 给业务人员看：动作前高亮目标 + 停顿（只在非 headless 时由调用方开启）
			if (opts2.flash) {
				await flashLocator(result.locator, Math.max(0, opts.stepDelayMs ?? 350))
			} else if (!(opts.headless ?? true) && (opts.stepDelayMs ?? 0) > 0) {
				await sleep(opts.stepDelayMs ?? 0)
			}
			return result
		}

		// page 用 getter：切标签页后 action/verify 自动作用在当前页上
		const actionDeps: ActionDeps = {
			get page() {
				return page
			},
			timeoutMs,
			log: pushLog,
			resolveTarget: (target, o) =>
				resolveTarget(target, { ...o, flash: opts.highlightSteps === true }),
			vars,
			// 点击可能触发原生对话框（manual 模式）：允许 click 在对话框出现时提前结束等待
			dialogPending: () => dialogMode === 'manual' && dialogManager.pendingCount > 0,
		}
		const verifyDeps: VerifyDeps = {
			get page() {
				return page
			},
			timeoutMs,
			log: pushLog,
			// expect 不带 AI：避免一步之内多次调用 AI，也避免校验被"修"成通过
			resolveTarget: (target, o) => resolveTarget(target, { ...o, allowAi: false }),
			// expect.download 的数据源：只看本步开始之后发生的下载
			recentDownloads: () => downloads.since(downloadCursor.current),
		}

		const flat = flattenSteps(flow.steps)

		// flow 第一步不是 navigate 时，先按 env.startUrl 打开页面（同样吃 baseUrl 重定基）
		const startPage = pages.pageAt(0)
		if (flat.length === 0 || flat[0]?.step.kind !== 'navigate') {
			const startUrl = rebaseUrl(env.startUrl, opts.baseUrl)
			try {
				if (startUrl !== env.startUrl) pushLog(`startUrl 重定基：${env.startUrl} → ${startUrl}`)
				// 慢站点/网络抖动：startUrl 打开重试 2 次（真实企业系统常见）
				let lastErr: unknown
				let opened = false
				for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
					try {
						await startPage.goto(startUrl, { timeout: timeoutMs, waitUntil: 'load' })
						opened = true
					} catch (err) {
						lastErr = err
						if (attempt < 2) {
							pushLog(
								`打开 startUrl 失败（第 ${attempt} 次），重试：${(err as Error).message.split('\n')[0]}`,
							)
							await sleep(1000)
						}
					}
				}
				if (!opened) throw lastErr
			} catch (err) {
				const classified = classifyError(err, 'navigate')
				const stepResult: StepResult = {
					stepId: '<startUrl>',
					kind: 'navigate',
					status: 'fail',
					ms: Date.now() - runStart,
					error: classified,
				}
				steps.push(stepResult)
				details.push({
					stepId: '<startUrl>',
					kind: 'navigate',
					status: 'fail',
					ms: stepResult.ms,
					error: classified,
					log: [`打开 startUrl 失败：${rebaseUrl(env.startUrl, opts.baseUrl)}`],
				})
				opts.onStep?.(stepResult)
			}
		}

		for (const item of flat) {
			if (browserCrashed) {
				const stepResult: StepResult = {
					stepId: item.stepId,
					kind: item.step.kind,
					status: 'skip',
					ms: 0,
					error: { code: 'BROWSER_CRASH', message: '浏览器已崩溃，后续步骤跳过' },
				}
				steps.push(stepResult)
				opts.onStep?.(stepResult)
				continue
			}

			const stepStart = Date.now()
			const stepLog: string[] = []
			const stepLogPush = (msg: string): void => {
				stepLog.push(msg)
				pushLog(msg)
			}
			const detail: StepDetail = {
				stepId: item.stepId,
				kind: item.step.kind,
				status: 'pass',
				ms: 0,
				log: stepLog,
			}

			let phase: FailurePhase = 'framework'
			let beforeShot: Buffer | undefined
			let expectNote: string | undefined

			try {
				stepIndexRef.current = item.index

				// ---- 目标标签页：step.page 优先；switchTab 用自己的 index；都没写则沿用当前 ----
				const desiredPageIndex = resolveStepPageIndex(item.step, pages.currentIndex)
				if (desiredPageIndex !== pages.currentIndex) {
					phase = 'action'
					page = (await pages.focus(desiredPageIndex, timeoutMs)).page
					stepLogPush(`切到标签页 ${desiredPageIndex}：${page.url()}`)
				} else {
					// 当前页可能已被关掉：PageManager 内部会回退到还活着的页并记日志
					page = pages.current()
				}
				detail.pageIndex = pages.currentIndex

				// manual 模式下上一步弹出的对话框必须由 dialog 步骤处理，否则页面被阻塞
				if (
					dialogMode === 'manual' &&
					dialogManager.pendingCount > 0 &&
					item.step.kind !== 'dialog'
				) {
					const pending = dialogManager.pendingList()[0]
					throw new StepFailure(
						'DIALOG_UNEXPECTED',
						`上一步弹出了原生对话框，但下一步不是 dialog 步骤（页面被阻塞）：${pending?.info ?? 'unknown'}`,
					)
				}
				const earlyDialogFailure = dialogManager.takeFailure()
				if (earlyDialogFailure) {
					throw new StepFailure(
						'DIALOG_UNEXPECTED',
						`dialogPolicy=fail：页面弹出了原生对话框（${earlyDialogFailure}）`,
					)
				}

				// 原生对话框处于"待处理"时页面 JS 是**阻塞**的：
				// 此时任何 page.evaluate / screenshot 都会挂到超时（曾经导致 play 卡死）。
				// 所以 dialog 步骤（以及紧随其后的步骤）只做"不碰页面"的动作。
				const dialogBlocking = dialogManager.pendingCount > 0

				// before.png 在内存里留着：失败时落盘，click/drag 的 NO_EFFECT 探测也用它
				if (!dialogBlocking && screenshotMode !== 'off' && item.step.kind !== 'navigate') {
					beforeShot = await page.screenshot({ type: 'png' }).catch(() => undefined)
				}

				const urlBefore = page.url()
				const dialogCountBefore = dialogManager.history.length
				const downloadsBefore = downloads.count
				const pagesBefore = pages.count
				const focusBefore = dialogBlocking ? '' : await activeElementSig(page)
				// 这一步"新发生"的下载从当前游标算起（避免上一步的下载冒充本步的）
				downloadCursor.current = downloads.cursor

				// ---- 模板渲染（navigate.url / upload.files / dialog.promptText …）----
				phase = 'template'
				const rendered = (() => {
					const base = renderStep(item.step, vars)
					// baseUrl：只换 origin，保留 path/query/hash（回放环境切换）
					if (base.kind === 'navigate') {
						const rebased = rebaseUrl(base.url, opts.baseUrl)
						if (rebased !== base.url) stepLogPush(`navigate 重定基：${base.url} → ${rebased}`)
						return { ...base, url: rebased }
					}
					return base
				})()
				if (rendered.kind === 'group') {
					throw new StepFailure('NOT_ACTIONABLE', 'group 步骤不应直接执行（应由 flatten 展开）')
				}

				// ---- 按类型执行 ----
				if (rendered.kind === 'switchTab') {
					phase = 'action'
					// 切页在目标标签页选择阶段已完成（step.page 与 switchTab.index 冲突时以 step.page 为准）
					stepLogPush(`switchTab ✓ 当前标签页 ${pages.currentIndex}（${page.url()}）`)
				} else if (rendered.kind === 'dialog') {
					phase = 'action'
					// 对话框可能挂在"别的标签页"上（弹窗由那个页触发）：先切到它
					const pendingDialog = dialogManager.pendingList()[0]
					if (pendingDialog?.page) {
						const dialogPageIndex = pages.slots.find(
							(slot) => slot.page === pendingDialog.page,
						)?.index
						if (dialogPageIndex !== undefined && dialogPageIndex !== pages.currentIndex) {
							page = (await pages.focus(dialogPageIndex, timeoutMs)).page
							detail.pageIndex = dialogPageIndex
							stepLogPush(`对话框在标签页 ${dialogPageIndex}，已切过去处理`)
						}
					}
					const handled = await dialogManager.resolve(
						rendered.action,
						rendered.promptText,
						timeoutMs,
					)
					stepLogPush(`dialog ${rendered.action} ✓ ${handled.info}`)
				} else if (rendered.kind === 'assert') {
					phase = 'expect'
					stepLogPush(`assert ${rendered.assertion.kind}`)
					const note = await runAssertion(verifyDeps, rendered.assertion, rendered.target)
					expectNote = `assert ${note}`
					stepLogPush(`assert ✓ ${note}`)
				} else {
					phase = rendered.kind === 'navigate' ? 'navigate' : 'action'
					const probeNeeded =
						!rendered.expect && (rendered.kind === 'click' || rendered.kind === 'drag')
					if (probeNeeded && !dialogBlocking) await armMutationProbe(page)

					const action = await runAction(actionDeps, rendered)
					if (action.level !== undefined) detail.level = action.level
					if (action.score !== undefined) detail.score = action.score
					if (action.ambiguous !== undefined) detail.ambiguous = action.ambiguous
					if (action.resolveReason !== undefined) detail.resolveReason = action.resolveReason
					if (action.extracted) stepLogPush(`extract → ${action.extracted.name}`)

					// L4 自愈命中：记录 + 现场生成候选（写回时用）
					const pendingRepair = pendingRepairRef.current
					if (detail.level === 'L4' && pendingRepair) {
						const usedValues =
							'target' in rendered && rendered.target
								? rendered.target.candidates.map((c) =>
										typeof c.value === 'string'
											? c.value
											: `${c.value.role}:${c.value.name ?? ''}`,
									)
								: []
						const candidate = pickCandidateFromFacts(pendingRepair.facts, usedValues)
						const from =
							'target' in rendered && rendered.target?.candidates[0]
								? describeCandidateForLog(rendered.target.candidates[0])
								: 'unknown'
						const heal: HealInput = {
							stepId: item.stepId,
							level: 'L4',
							from,
							at: new Date().toISOString(),
							confidence: pendingRepair.confidence,
							needsReview: pendingRepair.confidence < 0.7,
							...(candidate ? { to: describeCandidateForLog(candidate), candidate } : {}),
						}
						heals.push(heal)
						stepLogPush(
							`自愈：${from} → ${heal.to ?? '<无可用候选>'}（confidence=${pendingRepair.confidence}）`,
						)
						pendingRepairRef.current = null
					}

					// 动作执行期间弹了对话框（fail 策略）→ 本步失败，归因到当前步骤
					const lateDialogFailure = dialogManager.takeFailure()
					if (lateDialogFailure) {
						throw new StepFailure(
							'DIALOG_UNEXPECTED',
							`dialogPolicy=fail：动作触发了原生对话框（${lateDialogFailure}）`,
						)
					}

					if (probeNeeded && !dialogBlocking) {
						phase = 'action'
						await assertEffect(
							page,
							urlBefore,
							dialogCountBefore,
							dialogManager.history.length,
							beforeShot,
							screenshotMode,
							focusBefore,
							downloadsBefore,
							downloads.count,
							pagesBefore,
							pages.count,
							dialogMode,
							stepLogPush,
						)
					}
				}

				// ---- expect 校验（所有 step 类型通用）----
				if (rendered.expect) {
					phase = 'expect'
					expectNote = await verifyExpect(verifyDeps, rendered.expect)
				}

				detail.status = 'pass'
				if (expectNote !== undefined) stepLogPush(`expect ✓ ${expectNote}`)
			} catch (err) {
				const classified = classifyError(err, phase)
				detail.status = 'fail'
				detail.error = classified
				stepLogPush(`FAIL[${classified.code}] ${classified.message}`)

				// 失败必须落 artifact：before/after 截图 + snapshot.json + log.txt
				let stepDir: string | undefined
				try {
					const dialogBlocked = dialogManager.pendingCount > 0
					const afterShot =
						screenshotMode === 'off' || dialogBlocked
							? undefined
							: await page.screenshot({ type: 'png' }).catch(() => undefined)
					const snapshot = dialogBlocked
						? { skipped: '原生对话框挂起，页面 JS 阻塞，跳过页面快照' }
						: await captureSnapshot(page)
					stepDir = await artifacts.writeStepArtifacts(item.index, {
						...(beforeShot ? { before: beforeShot } : {}),
						...(afterShot ? { after: afterShot } : {}),
						snapshot: {
							stepId: item.stepId,
							kind: item.step.kind,
							error: classified,
							phase,
							url: page.url(),
							pageIndex: pages.currentIndex,
							page: snapshot,
						},
						log: stepLog,
					})
					detail.artifactDir = stepDir
				} catch (artifactErr) {
					stepLogPush(`artifact 落盘失败：${(artifactErr as Error).message}`)
				}
			}


			if (detail.status === 'pass' && screenshotMode === 'all' && dialogManager.pendingCount === 0) {
				try {
					const afterShot = await page.screenshot({ type: 'png' }).catch(() => undefined)
					detail.artifactDir = await artifacts.writeStepArtifacts(item.index, {
						...(beforeShot ? { before: beforeShot } : {}),
						...(afterShot ? { after: afterShot } : {}),
						snapshot: { stepId: item.stepId, kind: item.step.kind, status: 'pass' },
						log: stepLog,
					})
				} catch {
					/* 成功步骤落盘失败不影响结果 */
				}
			}

			const stepResult: StepResult = {
				stepId: item.stepId,
				kind: item.step.kind,
				status: detail.status,
				ms: Date.now() - stepStart,
			}
			if (detail.level !== undefined) stepResult.level = detail.level
			if (detail.error) stepResult.error = detail.error
			detail.ms = stepResult.ms
			steps.push(stepResult)
			details.push(detail)
			opts.onStep?.(stepResult)
		}
		observedPageCount = pages.count
	} finally {
		// 残留对话框必须关掉，否则 browser.close() 可能卡住
		await dialogManager.dismissRemaining().catch(() => 0)
		// 等下载保存落盘（result.json 里要写文件名列表）
		await downloads.flush().catch(() => undefined)
		// 给业务人员留时间看结果：headed 模式下成功停留 keepOpenMs，失败停留更久
		if (!(opts.headless ?? true)) {
			const hasFailure = steps.some((s) => s.status === 'fail')
			const keep = hasFailure ? (opts.keepOpenOnFailureMs ?? 15_000) : (opts.keepOpenMs ?? 1200)
			if (keep > 0) {
				pushLog(
					hasFailure
						? `有步骤失败，浏览器保持打开 ${Math.round(keep / 1000)}s 便于查看`
						: `回放完成，浏览器保持打开 ${Math.round(keep / 1000)}s`,
				)
				await sleep(keep)
			}
		}
		await browser.close().catch(() => {
			/* 浏览器可能已被外部关闭 */
		})
	}

	const passCount = steps.filter((s) => s.status === 'pass').length
	const failCount = steps.filter((s) => s.status === 'fail').length
	const totalMs = Date.now() - runStart
	const ok = failCount === 0 && steps.length > 0

	const result: RunResult = {
		flowId: flow.id,
		runId,
		ok,
		steps,
		metrics: { totalMs, passCount, failCount },
		artifactsDir: artifacts.runDir,
		flowVersion: flow.version,
	}
	if (heals.length > 0) {
		result.selfHealed = heals.map(({ candidate: _candidate, ...rest }) => rest as SelfHealRecord)
	}

	const report: RunReport = {
		...result,
		artifactsDir: artifacts.runDir,
		startedAt,
		finishedAt: new Date().toISOString(),
		dialogs: dialogManager.history,
		downloads: downloads.list().map((record) => record.filename),
		pages: observedPageCount,
		stepsDetail: details,
	}

	// result.json 无论成功失败都写（成功也有价值：性能/级别分布/耗时）
	try {
		await artifacts.writeResult(report)
	} catch (err) {
		pushLog(`result.json 落盘失败：${(err as Error).message}`)
	}

	return { result, report, heals }
}

/**
 * NO_EFFECT 探测：动作执行完但页面「一点变化都没有」时判失败。
 *
 * 三重信号（全部没变化才算无效）：MutationObserver 计数、url、JS 对话框。
 * 三者都静默时再用 before/after 截图字节比较兜底（勾选/输入这类只改 property 的操作
 * 不产生 DOM mutation，但像素一定会变）。
 */
async function assertEffect(
	page: Page,
	urlBefore: string,
	dialogsBefore: number,
	dialogsAfter: number,
	beforeShot: Buffer | undefined,
	screenshotMode: string,
	focusBefore: string,
	downloadsBefore: number,
	downloadsAfter: number,
	pagesBefore: number,
	pagesAfter: number,
	dialogMode: DialogMode,
	pushLog: (msg: string) => void,
): Promise<void> {
	// manual 模式下对话框会让页面 JS 阻塞：先给 dialog 事件一点时间到达，
	// 否则下面的 evaluate 会一直挂到超时。
	if (dialogMode === 'manual') {
		await sleep(80)
		if (dialogManagerHistoryChanged(dialogsBefore, dialogsAfter)) {
			pushLog('effect: 弹出 JS 对话框（manual 模式，等待 dialog 步骤处理）')
			return
		}
	}

	// 触发下载 / 新开标签页也是货真价实的副作用（这两类页面本身可能一点 DOM 都不变）
	if (downloadsAfter > downloadsBefore) {
		pushLog(`effect: 触发下载 ${downloadsAfter - downloadsBefore} 个`)
		return
	}
	if (pagesAfter > pagesBefore) {
		pushLog(`effect: 新开标签页 ${pagesAfter - pagesBefore} 个`)
		return
	}
	if (dialogManagerHistoryChanged(dialogsBefore, dialogsAfter)) {
		pushLog('effect: 弹出 JS 对话框')
		return
	}

	const mutations = await withTimeout(readMutationCount(page), 1_500, -1)
	if (mutations < 0) {
		pushLog('effect: 页面无响应（可能被对话框阻塞），跳过 NO_EFFECT 判定')
		return
	}
	if (mutations > 0) {
		pushLog(`effect: DOM 变更 ${mutations} 处`)
		return
	}
	if (page.url() !== urlBefore) {
		pushLog(`effect: url 变化 → ${page.url()}`)
		return
	}
	// 焦点落到被点元素上会触发 focus ring 重绘：这不算"页面有副作用"。
	// （否则所有可聚焦按钮都会被误判成 NO_EFFECT）
	const focusAfter = await withTimeout(activeElementSig(page), 800, focusBefore)
	if (focusAfter !== focusBefore) {
		pushLog(`effect: 焦点变化（${focusBefore || 'none'} → ${focusAfter || 'none'}，仅 UI 反馈）`)
		return
	}

	// 给异步渲染留一点时间再判一次
	await sleep(250)
	const mutationsLate = await withTimeout(readMutationCount(page), 1_500, -1)
	if (mutationsLate < 0) {
		pushLog('effect: 页面无响应，跳过 NO_EFFECT 判定')
		return
	}
	if (mutationsLate > 0 || page.url() !== urlBefore) {
		pushLog(`effect: 延迟确认到变化（mutation=${mutationsLate}）`)
		return
	}

	if (beforeShot && screenshotMode !== 'off') {
		const afterShot = await withTimeout(
			page.screenshot({ type: 'png' }).catch(() => undefined),
			3_000,
			undefined,
		)
		if (afterShot && afterShot.equals(beforeShot)) {
			throw new StepFailure(
				'NO_EFFECT',
				'动作已执行但页面无任何变化（DOM/url/像素均未变）：疑似命中了一个无效元素',
			)
		}
		pushLog('effect: 像素发生变化')
		return
	}

	throw new StepFailure(
		'NO_EFFECT',
		'动作已执行但页面无任何变化（DOM/url 均未变）：疑似命中了一个无效元素',
	)
}
