/**
 * Studio 本地控制台后端（业务人员用）。
 *
 * 形态：一个进程 = 本地 HTTP 服务 + 受控 Chromium（Playwright，可见窗口）。
 * 职责：录制会话管理、flow 读取/编辑、回放任务、artifact 静态服务。
 * 契约见 docs/studio-api.md；前端在 packages/studio/public（纯静态）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat as fsStat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadFlow, makeId, saveFlow, type Flow, type Step, type Variable } from '@rr/schema'
import { playRuns, type RunResult, type StepResult } from '@rr/executor'
import { record, type RecordOptions } from '@rr/recorder'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FLOWS_DIR = join(ROOT, 'flows')
const ARTIFACTS_DIR = join(ROOT, 'artifacts')
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

/* ------------------------------------------------------------------ */
/* 人话错误映射                                                         */
/* ------------------------------------------------------------------ */

const REASON_BY_CODE: Record<string, string> = {
	ELEMENT_NOT_FOUND: '页面上找不到这个元素，可能页面改版了或还没加载完',
	NOT_ACTIONABLE: '找到了元素但暂时点不了（被遮挡 / 不可见 / 未启用）',
	NO_EFFECT: '点了但页面没有反应，可能需要再确认一次',
	EXPECT_MISMATCH: '操作后页面没有出现预期变化',
	NAVIGATION_FAILED: '页面打开失败，请检查网址或网络',
	DIALOG_UNEXPECTED: '页面弹出了意外的对话框',
	BROWSER_CRASH: '浏览器异常退出',
	VARIABLE_MISSING: '缺少运行参数（变量没有填写）',
}

export function reasonOf(result: StepResult): string | undefined {
	const code = result.error?.code
	if (!code) return undefined
	return REASON_BY_CODE[code] ?? result.error?.message
}

/* ------------------------------------------------------------------ */
/* 人话步骤标题                                                         */
/* ------------------------------------------------------------------ */

function describeTarget(step: Step): string {
	if (!('target' in step) || !step.target) return ''
	const ref = step.target as { description?: string; observed?: { tag?: string; text?: string } }
	return ref.description ?? ref.observed?.text ?? ref.observed?.tag ?? '元素'
}

export function stepTitle(step: Step): string {
	const raw = stepTitleInner(step)
	// 多标签页流程：业务人员要能一眼看出"这一步发生在哪个页"
	const pageIndex = 'page' in step && step.page ? (step.page as { index: number }).index : undefined
	return pageIndex && pageIndex > 0 ? `标签页 ${pageIndex + 1}：${raw}` : raw
}

function stepTitleInner(step: Step): string {
	switch (step.kind) {
		case 'navigate':
			return `打开 ${step.url}`
		case 'click':
			return `点击「${describeTarget(step)}」`
		case 'input':
			return `在「${describeTarget(step)}」输入 ${JSON.stringify(step.value)}`
		case 'select':
			return `在「${describeTarget(step)}」选择 ${JSON.stringify(step.value)}`
		case 'key':
			return `按键 ${step.key}`
		case 'hover':
			return `悬停「${describeTarget(step)}」`
		case 'scroll':
			return `滚动${step.to ? `到 ${step.to}` : ''}`
		case 'drag':
			return '拖拽'
		case 'upload':
			return `上传文件到「${describeTarget(step)}」`
		case 'wait':
			return `等待${step.condition}${step.ms ? ` ${step.ms}ms` : ''}`
		case 'assert':
			return `检查 ${step.assertion.kind}`
		case 'extract':
			return `提取「${describeTarget(step)}」到变量 {{${step.into}}}`
		case 'script':
			return '执行脚本'
		case 'dialog':
			return `确认浏览器弹窗（${step.action === 'accept' ? '确定' : '取消'}）`
		case 'switchTab':
			return `切换到第 ${step.index + 1} 个标签页`
		case 'group':
			return `分组：${step.label}`
		default:
			return (step as { kind?: string }).kind ?? '操作'
	}
}

function flattenSteps(steps: Step[], out: Step[] = []): Step[] {
	for (const step of steps) {
		out.push(step)
		if (step.kind === 'group') flattenSteps(step.steps, out)
	}
	return out
}

interface StepSummary {
	index: number
	id: string
	kind: string
	title: string
	description?: string
	expect?: string
	screenshot?: string
}

export function summarize(flow: Flow): StepSummary[] {
	return flattenSteps(flow.steps).map((step, index) => {
		const target =
			'target' in step && step.target ? (step.target as { crop?: { ref: string } }) : undefined
		const cropRef = target?.crop?.ref
		return {
			index,
			id: step.id,
			kind: step.kind,
			title: stepTitle(step),
			...(step.expect ? { expect: step.expect.kind } : {}),
			// 录制时保存的元素裁剪图（相对 artifacts/<flowId>/ 的路径）
			...(cropRef ? { screenshot: `/artifacts/${flow.id}/${cropRef}` } : {}),
		}
	})
}

/* ------------------------------------------------------------------ */
/* 会话 / 任务状态                                                      */
/* ------------------------------------------------------------------ */

interface RecordSession {
	id: string
	url: string
	title: string
	file: string
	startedAt: number
	steps: StepSummary[]
	controller: AbortController
	promise: Promise<{ flow: Flow; artifactsDir: string } | null>
	cancelled: boolean
}

interface PlaybackRun {
	id: string
	file: string
	status: 'running' | 'done' | 'error'
	startedAt: number
	runs: Array<{
		ok: boolean
		steps: Array<{
			id: string
			kind: string
			status: string
			level?: string
			ms: number
			code?: string
			reason?: string
			screenshot?: string
		}>
	}>
	message?: string
}

const sessions = new Map<string, RecordSession>()
const playbackRuns = new Map<string, PlaybackRun>()

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

function json(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	})
	res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	if (!chunks.length) return {}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
	} catch {
		return {}
	}
}

function safeJoin(base: string, sub: string): string | undefined {
	const target = resolvePath(base, sub)
	if (!target.startsWith(resolvePath(base))) return undefined
	return target
}

async function serveStatic(res: ServerResponse, file: string): Promise<void> {
	try {
		const data = await readFile(file)
		const ext = extname(file)
		const type =
			ext === '.html'
				? 'text/html; charset=utf-8'
				: ext === '.js'
					? 'text/javascript; charset=utf-8'
					: ext === '.css'
						? 'text/css; charset=utf-8'
						: ext === '.png'
							? 'image/png'
							: ext === '.json'
								? 'application/json; charset=utf-8'
								: 'application/octet-stream'
		res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
		res.end(data)
	} catch {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
		res.end('not found')
	}
}

function flowFileFromName(name: string): string | undefined {
	const safe = safeJoin(FLOWS_DIR, name)
	if (!safe || !safe.endsWith('.json') || !existsSync(safe)) return undefined
	return safe
}

/* ------------------------------------------------------------------ */
/* 流程相关                                                            */
/* ------------------------------------------------------------------ */

async function listFlows(): Promise<Array<Record<string, unknown>>> {
	await mkdir(FLOWS_DIR, { recursive: true })
	const files = (await readdir(FLOWS_DIR))
		.filter((f) => f.endsWith('.json') && !f.endsWith('.bak'))
		.sort()
	const out: Array<Record<string, unknown>> = []
	for (const file of files) {
		try {
			const full = join(FLOWS_DIR, file)
			const flow = await loadFlow(full)
			const stat = await fsStat(full).catch(() => undefined)
			out.push({
				file,
				title: flow.title,
				steps: flattenSteps(flow.steps).length,
				version: flow.version,
				...(stat ? { updatedAt: stat.mtime.toISOString() } : {}),
			})
		} catch {
			/* 非法 flow 不进列表 */
		}
	}
	return out
}

/* ------------------------------------------------------------------ */
/* 录制                                                                */
/* ------------------------------------------------------------------ */

async function startRecording(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const url = String(body.url ?? '').trim()
	if (!url) throw new Error('缺少 url')
	const title = String(body.title ?? `录制 ${new URL(url).host}`)
	const id = makeId('rec')
	const file = `studio-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`
	const controller = new AbortController()
	const session: RecordSession = {
		id,
		url,
		title,
		file,
		startedAt: Date.now(),
		steps: [],
		controller,
		promise: Promise.resolve(null),
		cancelled: false,
	}
	sessions.set(id, session)

	const options: RecordOptions = {
		startUrl: url,
		outPath: join(FLOWS_DIR, file),
		headless: false,
		stopSignal: controller.signal,
		onStep: (step) => {
			session.steps.push({
				index: session.steps.length,
				id: step.id,
				kind: step.kind,
				title: stepTitle(step),
			})
		},
	}
	// 录制时让用户自己操作；record() 在 stop 后落盘
	session.promise = record(options)
		.then((result) => {
			if (!session.cancelled) {
				console.log(`[studio] 录制完成：${file}（${result.flow.steps.length} 步）`)
			}
			return result
		})
		.catch((err: Error) => {
			console.error(`[studio] 录制失败：${err.message}`)
			return null
		})
	return { sessionId: id }
}

async function stopRecording(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const session = sessions.get(String(body.sessionId ?? ''))
	if (!session) throw new Error('录制会话不存在')
	session.controller.abort()
	const result = await session.promise
	if (!result) throw new Error('录制失败（没有产生 flow）')

	// 录制后自检：立刻回放一次（headless），失败步骤标出来
	const selfCheck = await runSelfCheck(result.flow, join(FLOWS_DIR, session.file))
	return { file: session.file, flow: result.flow, selfCheck }
}

async function runSelfCheck(flow: Flow, file: string): Promise<Record<string, unknown>> {
	try {
		const runs = await playRuns({ flow, runs: 1, headless: true })
		const steps = runs[0]?.steps ?? []
		const failed = steps.filter((s) => s.status !== 'pass')
		return {
			ok: failed.length === 0,
			steps: steps.map((s) => ({
				id: s.stepId,
				status: s.status,
				...(s.level ? { level: s.level } : {}),
				...(s.error ? { reason: reasonOf(s) ?? s.error.message } : {}),
			})),
			summary: failed.length
				? `自检：${failed.length}/${steps.length} 步没通过，建议重录这些步骤（${file}）`
				: `自检通过：${steps.length} 步全部可回放`,
		}
	} catch (err) {
		return { ok: false, steps: [], summary: `自检出错：${(err as Error).message}` }
	}
}

/* ------------------------------------------------------------------ */
/* 回放                                                                */
/* ------------------------------------------------------------------ */

async function startPlayback(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const file = String(body.file ?? '')
	const flowFile = flowFileFromName(file)
	if (!flowFile) throw new Error('流程文件不存在')
	const flow = await loadFlow(flowFile)
	const runs = Math.max(1, Math.min(10, Number(body.runs ?? 1)))
	const variables = (body.variables as Record<string, string> | undefined) ?? undefined
	const id = makeId('run')
	const job: PlaybackRun = { id, file, status: 'running', startedAt: Date.now(), runs: [] }
	playbackRuns.set(id, job)

	void (async () => {
		try {
			// 业务人员默认看得到浏览器：headed 时放慢节奏 + 高亮目标，看起来像"有人在帮你填"
			const headed = body.headed === undefined ? true : Boolean(body.headed)
			const results: RunResult[] = await playRuns({
				flow,
				runs,
				headless: !headed,
				...(variables ? { variables } : {}),
				...(headed
					? {
							stepDelayMs: 350,
							highlightSteps: true,
							keepOpenMs: 1500,
							keepOpenOnFailureMs: 20_000,
						}
					: {}),
			})
			job.runs = results.map((r) => ({
				ok: r.ok,
				steps: r.steps.map((s, stepIndex) => ({
					id: s.stepId,
					kind: s.kind,
					status: s.status,
					...(s.level ? { level: s.level } : {}),
					ms: s.ms,
					...(s.error ? { code: s.error.code, reason: reasonOf(s) ?? s.error.message } : {}),
					screenshot: screenshotUrl(flow.id, r.runId, stepIndex, s.status),
				})),
			}))
			job.status = 'done'
			console.log(
				`[studio] 回放完成：${file} ${job.runs.filter((r) => r.ok).length}/${job.runs.length}`,
			)
		} catch (err) {
			job.status = 'error'
			job.message = (err as Error).message
		}
	})()
	return { runId: id }
}

/** 失败步骤用 after.png，通过步骤用 before.png（存在才给 URL） */
function screenshotUrl(
	flowId: string,
	runId: string,
	stepIndex: number,
	status: string,
): string | undefined {
	const base = join(ARTIFACTS_DIR, flowId, 'runs', runId, String(stepIndex))
	const file = status === 'pass' ? join(base, 'before.png') : join(base, 'after.png')
	if (!existsSync(file)) return undefined
	return `/artifacts/${flowId}/runs/${runId}/${stepIndex}/${status === 'pass' ? 'before' : 'after'}.png`
}

/* ------------------------------------------------------------------ */
/* 编辑                                                                */
/* ------------------------------------------------------------------ */

async function updateFlow(file: string, mutate: (flow: Flow) => void): Promise<Flow> {
	const flowFile = flowFileFromName(file)
	if (!flowFile) throw new Error('流程文件不存在')
	const flow = await loadFlow(flowFile)
	mutate(flow)
	await saveFlow(flow, flowFile, { backup: true })
	return flow
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
	const path = url.pathname
	if (!path.startsWith('/api/')) return false
	const method = req.method ?? 'GET'

	if (path === '/api/config' && method === 'GET') {
		json(res, 200, {
			aiEnabled: Boolean(process.env.RR_AI_ENABLED === '1'),
			flowsDir: FLOWS_DIR,
			artifactsDir: ARTIFACTS_DIR,
		})
		return true
	}
	if (path === '/api/flows' && method === 'GET') {
		json(res, 200, { flows: await listFlows() })
		return true
	}
	const flowMatch = /^\/api\/flows\/([^/]+)$/.exec(path)
	if (flowMatch && method === 'GET') {
		const flowFile = flowFileFromName(decodeURIComponent(flowMatch[1]!))
		if (!flowFile) return (json(res, 404, { error: 'flow 不存在' }), true)
		const flow = await loadFlow(flowFile)
		json(res, 200, { flow, steps: summarize(flow) })
		return true
	}
	const renameMatch = /^\/api\/flows\/([^/]+)\/rename$/.exec(path)
	if (renameMatch && method === 'POST') {
		const body = await readBody(req)
		const flow = await updateFlow(decodeURIComponent(renameMatch[1]!), (f) => {
			f.title = String(body.title ?? f.title)
		})
		json(res, 200, { ok: true, flow })
		return true
	}
	const deleteMatch = /^\/api\/flows\/([^/]+)\/steps\/([^/]+)\/delete$/.exec(path)
	if (deleteMatch && method === 'POST') {
		const flow = await updateFlow(decodeURIComponent(deleteMatch[1]!), (f) => {
			f.steps = f.steps.filter((s) => s.id !== deleteMatch[2])
		})
		json(res, 200, { ok: true, flow })
		return true
	}
	const varsMatch = /^\/api\/flows\/([^/]+)\/variables$/.exec(path)
	if (varsMatch && method === 'POST') {
		const body = await readBody(req)
		const next = (body.variables as Array<{ name: string; value?: string }> | undefined) ?? []
		const flow = await updateFlow(decodeURIComponent(varsMatch[1]!), (f) => {
			// merge 语义：已存在的变量保留 name/secret/type，只更新 defaultValue；新变量追加
			const byName = new Map<string, Variable>(f.variables.map((v) => [v.name, v]))
			for (const incoming of next) {
				const existing = byName.get(incoming.name)
				const merged: Variable = existing
					? {
							...existing,
							...(incoming.value !== undefined ? { defaultValue: incoming.value } : {}),
						}
					: {
							name: incoming.name,
							type: incoming.name === 'password' ? 'secret' : 'string',
							secret: incoming.name === 'password',
							source: 'input',
							...(incoming.value !== undefined ? { defaultValue: incoming.value } : {}),
						}
				byName.set(incoming.name, merged)
			}
			f.variables = [...byName.values()]
		})
		json(res, 200, { ok: true, flow })
		return true
	}

	if (path === '/api/record/start' && method === 'POST') {
		try {
			json(res, 200, await startRecording(await readBody(req)))
		} catch (err) {
			json(res, 400, { error: (err as Error).message })
		}
		return true
	}
	if (path === '/api/record/status' && method === 'GET') {
		const session = sessions.get(url.searchParams.get('sessionId') ?? '')
		if (!session) return (json(res, 404, { error: '会话不存在' }), true)
		json(res, 200, {
			recording: !session.cancelled,
			steps: session.steps,
			elapsedMs: Date.now() - session.startedAt,
		})
		return true
	}
	if (path === '/api/record/stop' && method === 'POST') {
		try {
			json(res, 200, await stopRecording(await readBody(req)))
		} catch (err) {
			json(res, 400, { error: (err as Error).message })
		}
		return true
	}
	if (path === '/api/record/cancel' && method === 'POST') {
		const body = await readBody(req)
		const session = sessions.get(String(body.sessionId ?? ''))
		if (session) {
			session.cancelled = true
			session.controller.abort()
		}
		json(res, 200, { ok: true })
		return true
	}

	if (path === '/api/play' && method === 'POST') {
		try {
			json(res, 200, await startPlayback(await readBody(req)))
		} catch (err) {
			json(res, 400, { error: (err as Error).message })
		}
		return true
	}
	const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path)
	if (runMatch && method === 'GET') {
		const job = playbackRuns.get(runMatch[1]!)
		if (!job) return (json(res, 404, { error: '任务不存在' }), true)
		json(res, 200, job)
		return true
	}
	json(res, 404, { error: `未知接口 ${method} ${path}` })
	return true
}

export interface StudioServerOptions {
	port?: number
}

export function createStudioServer(): Promise<{ port: number; close: () => Promise<void> }> {
	const port = Number(process.env.RR_STUDIO_PORT ?? 4400)
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
			void (async () => {
				try {
					if (await handleApi(req, res, url)) return
					if (url.pathname.startsWith('/artifacts/')) {
						const rel = decodeURIComponent(url.pathname.slice('/artifacts/'.length))
						const safe = safeJoin(ARTIFACTS_DIR, rel)
						if (!safe) return void (res.writeHead(403), res.end())
						await serveStatic(res, safe)
						return
					}
					const file =
						url.pathname === '/'
							? join(PUBLIC_DIR, 'index.html')
							: safeJoin(PUBLIC_DIR, url.pathname.slice(1))
					if (!file) return void (res.writeHead(403), res.end())
					await serveStatic(res, file)
				} catch (err) {
					console.error('[studio] 请求失败', err)
					if (!res.headersSent) json(res, 500, { error: (err as Error).message })
					else res.end()
				}
			})()
		})
		server.on('error', reject)
		server.listen(port, '127.0.0.1', () => {
			const actual = (server.address() as { port: number }).port
			console.log(`\n  Studio 已启动：http://127.0.0.1:${actual}\n  数据目录：${FLOWS_DIR}\n`)
			resolve({ port: actual, close: () => new Promise<void>((r) => server.close(() => r())) })
		})
	})
}
