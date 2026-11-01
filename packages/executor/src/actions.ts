/**
 * 动作执行（契约见 docs/architecture.md §5）。
 *
 * 关键约定：
 * - click 先 `{ trial: true }` 跑一遍 actionability 检查再真点 —— 这样"不可交互"能立刻
 *   归到 NOT_ACTIONABLE，而不是等真点超时后报一个看不懂的 timeout；
 * - 每个 target 的 `release()`（L2 打的临时标记）必须在 finally 里清掉；
 * - 不在这里做 expect 校验（verify.ts 负责），但 extract 会写变量。
 */
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import type { ElementRef, Step } from '@rr/schema'
import type { Page } from 'playwright'
import type { ResolveLevel, ResolveResult } from '@rr/resolver'

import { StepFailure } from './errors.js'

export interface ActionDeps {
	page: Page
	timeoutMs: number
	log: (msg: string) => void
	resolveTarget: (target: ElementRef, opts?: { requireVisible?: boolean }) => Promise<ResolveResult>
	/** extract 写入这里，后续步骤可用 {{var}} */
	vars: Record<string, string>
}

export interface ActionResult {
	level?: ResolveLevel
	score?: number
	ambiguous?: boolean
	resolveReason?: string
	extracted?: { name: string; value: string }
	note?: string
}

type ActionStep = Exclude<Step, { kind: 'group' }>

function metaOf(hit: ResolveResult): Pick<ActionResult, 'level' | 'score' | 'ambiguous' | 'resolveReason'> {
	const out: Pick<ActionResult, 'level' | 'score' | 'ambiguous' | 'resolveReason'> = {
		level: hit.level,
		score: hit.score,
		ambiguous: hit.ambiguous,
	}
	if (hit.reason !== undefined) out.resolveReason = hit.reason
	return out
}

/** 解析 → 执行 → 清理标记 */
async function withTarget<T>(
	deps: ActionDeps,
	target: ElementRef,
	fn: (hit: ResolveResult) => Promise<T>,
): Promise<{ value: T; hit: ResolveResult }> {
	const hit = await deps.resolveTarget(target)
	try {
		return { value: await fn(hit), hit }
	} finally {
		if (hit.release) await hit.release()
	}
}

async function bestEffortNetworkIdle(page: Page, timeoutMs: number): Promise<void> {
	try {
		await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 3_000) })
	} catch {
		/* 页面一直有轮询请求时不算失败，普通 load 已经等过 */
	}
}

export async function runAction(deps: ActionDeps, step: ActionStep): Promise<ActionResult> {
	const timeout = deps.timeoutMs

	switch (step.kind) {
		case 'navigate': {
			const target = step.url
			deps.log(`navigate → ${target}`)
			// 直接抛给 classify：net::ERR_* / 超时会被归成 NAVIGATION_FAILED
			await deps.page.goto(target, { timeout, waitUntil: 'load' })
			await bestEffortNetworkIdle(deps.page, timeout)
			return { note: `url=${deps.page.url()}` }
		}

		case 'click': {
			// closed shadow（spike A）：Playwright selector 进不去 shadow 内部，
			// 只能点 host 并带 padding-box 相对偏移；position 优先用 step.position，
			// 其次回退到录制时记下的 observed.innerOffset。
			const closedShadow = step.target.observed.shadowRootType === 'closed'
			const position = step.position ?? (closedShadow ? step.target.observed.innerOffset : undefined)
			if (closedShadow && !position) {
				throw new StepFailure(
					'NOT_ACTIONABLE',
					'closed shadow 目标缺少 position/innerOffset：无法用 host + 偏移点中内层元素',
				)
			}

			const { hit } = await withTarget(deps, step.target, async (h) => {
				// 1) 试跑：只做 actionability 检查，不产生真实点击
				await h.locator.click({ trial: true, timeout, ...(position ? { position } : {}) })
				// 2) 真点
				const options: Parameters<typeof h.locator.click>[0] = {
					timeout,
					button: step.button,
					clickCount: step.clickCount,
				}
				if (step.modifiers.length > 0) options.modifiers = [...step.modifiers]
				if (position) options.position = position
				await h.locator.click(options)
			})
			const where = closedShadow
				? `host+position(${position?.x ?? 0},${position?.y ?? 0})`
				: 'locator'
			deps.log(`click ${hit.level} ${where}${hit.ambiguous ? '（降级/歧义）' : ''} ✓`)
			return { ...metaOf(hit), note: closedShadow ? 'click-host-with-position' : 'clicked' }
		}

		case 'input': {
			const { hit } = await withTarget(deps, step.target, async (h) => {
				await h.locator.waitFor({ state: 'visible', timeout })
				// 契约：input 用 fill；clear=false 时改成追加输入
				if (step.clear) await h.locator.fill(step.value, { timeout })
				else await h.locator.pressSequentially(step.value, { timeout })
			})
			deps.log(`input ${hit.level} ✓（${step.clear ? 'fill' : 'type'}）`)
			return metaOf(hit)
		}

		case 'select': {
			const values = Array.isArray(step.value) ? step.value : [step.value]
			const { hit } = await withTarget(deps, step.target, async (h) => {
				await h.locator.waitFor({ state: 'visible', timeout })
				try {
					await h.locator.selectOption(values, { timeout })
				} catch (err) {
					// 有些站点 option 的 value 和展示文案不同：退化成按 label 选
					const labels = values.map((value) => ({ label: value }))
					try {
						await h.locator.selectOption(labels, { timeout })
					} catch {
						throw err
					}
				}
			})
			deps.log(`select ${hit.level} ✓ ${values.join(', ')}`)
			return metaOf(hit)
		}

		case 'upload': {
			const files = step.files.map((file) => resolvePath(file))
			for (const file of files) {
				if (!existsSync(file)) {
					throw new StepFailure('NOT_ACTIONABLE', `上传文件不存在：${file}`)
				}
			}
			const { hit } = await withTarget(deps, step.target, async (h) => {
				await h.locator.setInputFiles(files, { timeout })
			})
			deps.log(`upload ${hit.level} ✓ ${files.length} 个文件`)
			return metaOf(hit)
		}

		case 'key': {
			if (step.target) {
				const { hit } = await withTarget(deps, step.target, async (h) => {
					await h.locator.press(step.key, { timeout })
				})
				deps.log(`key ${step.key} on ${hit.level} ✓`)
				return metaOf(hit)
			}
			await deps.page.keyboard.press(step.key)
			deps.log(`key ${step.key} on page ✓`)
			return { note: `key=${step.key}` }
		}

		case 'hover': {
			const { hit } = await withTarget(deps, step.target, async (h) => {
				await h.locator.hover({ timeout })
			})
			deps.log(`hover ${hit.level} ✓`)
			return metaOf(hit)
		}

		case 'scroll': {
			if (step.target && step.to) {
				const { hit } = await withTarget(deps, step.target, async (h) => {
					await h.locator.evaluate((el, to) => {
						const scrollable = el as HTMLElement
						const top = to === 'top' ? 0 : scrollable.scrollHeight
						if (typeof scrollable.scrollTo === 'function') scrollable.scrollTo({ top })
						else scrollable.scrollIntoView(to === 'top')
					}, step.to as 'top' | 'bottom')
				})
				return metaOf(hit)
			}
			if (step.target) {
				const { hit } = await withTarget(deps, step.target, async (h) => {
					await h.locator.scrollIntoViewIfNeeded({ timeout })
				})
				deps.log(`scroll into view ${hit.level} ✓`)
				return metaOf(hit)
			}
			if (step.to) {
				await deps.page.evaluate((to) => {
					window.scrollTo(0, to === 'top' ? 0 : document.body.scrollHeight)
				}, step.to)
				deps.log(`scroll to ${step.to} ✓`)
				return { note: `scroll=${step.to}` }
			}
			const delta = step.delta ?? { x: 0, y: 0 }
			const viewport = deps.page.viewportSize() ?? { width: 1280, height: 720 }
			await deps.page.mouse.move(viewport.width / 2, viewport.height / 2)
			await deps.page.mouse.wheel(delta.x ?? 0, delta.y ?? 0)
			deps.log(`wheel ${delta.x ?? 0},${delta.y ?? 0} ✓`)
			return { note: 'wheel' }
		}

		case 'drag': {
			if (step.to.target) {
				const { hit } = await withTarget(deps, step.from, async (fromHit) => {
					const toHit = await deps.resolveTarget(step.to.target as ElementRef)
					try {
						await fromHit.locator.dragTo(toHit.locator, { timeout })
					} finally {
						if (toHit.release) await toHit.release()
					}
				})
				deps.log(`drag → target ${hit.level} ✓`)
				return metaOf(hit)
			}
			if (step.to.x === undefined || step.to.y === undefined) {
				throw new StepFailure('NOT_ACTIONABLE', 'drag 目标既没有 target 也没有 x/y 坐标')
			}
			const toX = step.to.x
			const toY = step.to.y
			const startPosition =
				step.from.observed.shadowRootType === 'closed'
					? (step.from.observed.innerOffset ?? undefined)
					: undefined
			const { hit } = await withTarget(deps, step.from, async (h) => {
				const box = await h.locator.boundingBox({ timeout })
				if (!box) throw new StepFailure('NOT_ACTIONABLE', 'drag 源元素没有可见包围盒')
				if (startPosition) {
					await deps.page.mouse.move(box.x + startPosition.x, box.y + startPosition.y)
				} else {
					await deps.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
				}
				await deps.page.mouse.down()
				await deps.page.mouse.move(toX, toY, { steps: 12 })
				await deps.page.mouse.up()
			})
			deps.log(`drag → (${toX},${toY}) ${hit.level} ✓`)
			return metaOf(hit)
		}

		case 'wait': {
			if (step.condition === 'timeout') {
				const ms = step.ms ?? 1_000
				deps.log(`wait ${ms}ms`)
				await deps.page.waitForTimeout(ms)
				return { note: `wait=${ms}ms` }
			}
			if (step.condition === 'networkIdle') {
				deps.log('wait networkIdle')
				await deps.page.waitForLoadState('networkidle', { timeout })
				return { note: 'networkIdle' }
			}
			if (!step.target) throw new StepFailure('NOT_ACTIONABLE', 'wait element 缺少 target')
			const { hit } = await withTarget(deps, step.target, async (h) => {
				await h.locator.waitFor({ state: 'visible', timeout })
			})
			deps.log(`wait element ${hit.level} ✓`)
			return metaOf(hit)
		}

		case 'extract': {
			const { value, hit } = await withTarget(deps, step.target, async (h) => {
				if (step.prop === 'text') return (await h.locator.textContent({ timeout }))?.trim() ?? ''
				if (step.prop === 'value') return await h.locator.inputValue({ timeout })
				if (!step.attr) throw new StepFailure('NOT_ACTIONABLE', 'extract prop=attr 但缺少 attr 名')
				return (await h.locator.getAttribute(step.attr, { timeout })) ?? ''
			})
			deps.vars[step.into] = value
			deps.log(`extract ${step.prop} → {{${step.into}}} = ${value.slice(0, 80)}`)
			return { ...metaOf(hit), extracted: { name: step.into, value } }
		}

		case 'script': {
			deps.log(`script ${step.code.slice(0, 60)}…`)
			await deps.page.evaluate(step.code)
			return { note: 'script' }
		}

		case 'assert': {
			// 断言本身在 verify.ts 里判定，这里只把 target 解析出来（由 run.ts 统一调用）
			throw new StepFailure('EXPECT_MISMATCH', 'assert 步骤应由 verify 分支处理')
		}

		default: {
			const never: never = step
			throw new StepFailure('NOT_ACTIONABLE', `未知 step 类型：${JSON.stringify(never)}`)
		}
	}
}
