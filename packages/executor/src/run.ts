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
import { flattenSteps } from './steps.js'
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

async function readMutationCount(page: Page): Promise<number> {
	return page
		.evaluate(() => {
			const w = window as unknown as { __rrMut?: number }
			return w.__rrMut ?? 0
		})
		.catch(() => 0)
}

export async function executeRun(
	opts: PlayOptions,
	runId: string = makeId('run'),
): Promise<RunOutcome> {
	const flow: Flow = opts.flow
	const timeoutMs = opts.timeoutMs ?? 15_000
	const screenshotMode = opts.screenshotMode ?? 'failures'
	const dialogPolicy = opts.dialogPolicy ?? 'dismiss'
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
	const dialogs: string[] = []
	const log = (msg: string): void => {
		opts.onLog?.(msg)
	}

	const logLines: string[] = []
	const pushLog = (msg: string): void => {
		logLines.push(msg)
		log(`[${flow.id}] ${msg}`)
	}

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
		const page = await context.newPage()
		page.setDefaultTimeout(timeoutMs)

		page.on('dialog', (dialog) => {
			const info = `${dialog.type()}: ${dialog.message()}`
			dialogs.push(info)
			pushLog(`检测到 JS 对话框（${dialogPolicy}）：${info}`)
			void dialog.dismiss().catch(() => {
				/* 页面可能已关闭 */
			})
		})
		page.on('crash', () => {
			browserCrashed = true
			pushLog('页面崩溃（page.on("crash")）')
		})

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
			opts2: { requireVisible?: boolean; allowAi?: boolean } = {},
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
				},
			})
			return result
		}

		const actionDeps: ActionDeps = { page, timeoutMs, log: pushLog, resolveTarget, vars }
		const verifyDeps: VerifyDeps = {
			page,
			timeoutMs,
			log: pushLog,
			// expect 不带 AI：避免一步之内多次调用 AI，也避免校验被"修"成通过
			resolveTarget: (target, o) => resolveTarget(target, { ...o, allowAi: false }),
		}

		const flat = flattenSteps(flow.steps)

		// flow 第一步不是 navigate 时，先按 env.startUrl 打开页面（同样吃 baseUrl 重定基）
		if (flat.length === 0 || flat[0]?.step.kind !== 'navigate') {
			const startUrl = rebaseUrl(env.startUrl, opts.baseUrl)
			try {
				if (startUrl !== env.startUrl) pushLog(`startUrl 重定基：${env.startUrl} → ${startUrl}`)
				// 慢站点/网络抖动：startUrl 打开重试 2 次（真实企业系统常见）
				let lastErr: unknown
				let opened = false
				for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
					try {
						await page.goto(startUrl, { timeout: timeoutMs, waitUntil: 'load' })
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

			// before.png 在内存里留着：失败时落盘，click/drag 的 NO_EFFECT 探测也用它
			if (screenshotMode !== 'off' && item.step.kind !== 'navigate') {
				beforeShot = await page.screenshot({ type: 'png' }).catch(() => undefined)
			}

			try {
				const urlBefore = page.url()
				const dialogCountBefore = dialogs.length
				const focusBefore = await activeElementSig(page)

				if (item.step.kind === 'assert') {
					phase = 'expect'
					const rendered = renderStep(item.step, vars) as Extract<
						typeof item.step,
						{ kind: 'assert' }
					>
					stepLogPush(`assert ${rendered.assertion.kind}`)
					const note = await runAssertion(verifyDeps, rendered.assertion, rendered.target)
					expectNote = `assert ${note}`
					stepLogPush(`assert ✓ ${note}`)
				} else {
					const rendered = (() => {
						phase = 'template'
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
					phase = rendered.kind === 'navigate' ? 'navigate' : 'action'
					const probeNeeded =
						!rendered.expect && (rendered.kind === 'click' || rendered.kind === 'drag')
					if (probeNeeded) await armMutationProbe(page)

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
										typeof c.value === 'string' ? c.value : `${c.value.role}:${c.value.name ?? ''}`,
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

					if (rendered.expect) {
						phase = 'expect'
						expectNote = await verifyExpect(verifyDeps, rendered.expect)
					} else if (probeNeeded) {
						phase = 'action'
						await assertEffect(
							page,
							urlBefore,
							dialogCountBefore,
							dialogs.length,
							beforeShot,
							screenshotMode,
							focusBefore,
							stepLogPush,
						)
					}
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
					const afterShot =
						screenshotMode === 'off'
							? undefined
							: await page.screenshot({ type: 'png' }).catch(() => undefined)
					const snapshot = await captureSnapshot(page)
					stepDir = await artifacts.writeStepArtifacts(item.index, {
						...(beforeShot ? { before: beforeShot } : {}),
						...(afterShot ? { after: afterShot } : {}),
						snapshot: {
							stepId: item.stepId,
							kind: item.step.kind,
							error: classified,
							phase,
							url: page.url(),
							page: snapshot,
						},
						log: stepLog,
					})
					detail.artifactDir = stepDir
				} catch (artifactErr) {
					stepLogPush(`artifact 落盘失败：${(artifactErr as Error).message}`)
				}
			}

			if (detail.status === 'pass' && screenshotMode === 'all') {
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
	} finally {
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
		dialogs,
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
	pushLog: (msg: string) => void,
): Promise<void> {
	const mutations = await readMutationCount(page)
	if (mutations > 0) {
		pushLog(`effect: DOM 变更 ${mutations} 处`)
		return
	}
	if (page.url() !== urlBefore) {
		pushLog(`effect: url 变化 → ${page.url()}`)
		return
	}
	if (dialogsAfter > dialogsBefore) {
		pushLog('effect: 弹出 JS 对话框')
		return
	}

	// 焦点落到被点元素上会触发 focus ring 重绘：这不算"页面有副作用"。
	// （否则所有可聚焦按钮都会被误判成 NO_EFFECT）
	const focusAfter = await activeElementSig(page)
	if (focusAfter !== focusBefore) {
		pushLog(`effect: 焦点变化（${focusBefore || 'none'} → ${focusAfter || 'none'}，仅 UI 反馈）`)
		return
	}

	// 给异步渲染留一点时间再判一次
	await sleep(250)
	const mutationsLate = await readMutationCount(page)
	if (mutationsLate > 0 || page.url() !== urlBefore) {
		pushLog(`effect: 延迟确认到变化（mutation=${mutationsLate}）`)
		return
	}

	if (beforeShot && screenshotMode !== 'off') {
		const afterShot = await page.screenshot({ type: 'png' }).catch(() => undefined)
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
