/**
 * Studio 本地控制台后端（业务人员用）。
 *
 * 形态：一个进程 = 本地 HTTP 服务 + 受控 Chromium（Playwright，可见窗口）。
 * 职责：录制会话管理、flow 读取/编辑、回放任务、artifact 静态服务。
 * 契约见 docs/studio-api.md；前端在 packages/studio/public（纯静态）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat as fsStat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type BrowserContext } from 'playwright'

import { loadFlow, makeId, saveFlow, type Flow, type Step, type Variable } from '@rr/schema'
import {
	analyzeFlow,
	applySuggestion,
	applySuggestions,
	renameVariable,
	SuggestError,
	type ApplyResult,
	type ApplySuggestionInput,
	type FlowSuggestions,
	type SuggestVariableType,
} from '@rr/suggest'
import { playRuns, type RunResult, type StepResult } from '@rr/executor'
import { record, type RecordOptions } from '@rr/recorder'

import {
	deleteProfile,
	listProfiles,
	originOf,
	profilePathFor,
	storageStatePathIfExists,
	writeProfile,
	type ProfileMeta,
} from './profiles.js'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** 默认目录（生产用）；测试/多实例可用 createStudioServer({flowsDir, artifactsDir}) 或环境变量覆盖 */
const DEFAULT_FLOWS_DIR = join(ROOT, 'flows')
const DEFAULT_ARTIFACTS_DIR = join(ROOT, 'artifacts')
const DEFAULT_PROFILES_DIR = join(ROOT, 'profiles')

export interface StudioConfig {
	flowsDir: string
	artifactsDir: string
	/** 登录态（storageState）目录，见 docs/profiles-rerecord.md §A */
	profilesDir: string
}

/**
 * 解析运行目录：显式参数 > 环境变量 > 默认值。
 * 之所以要可注入：API 测试必须用**临时目录 + 临时端口**，不能碰 4400 上正在跑的服务和真实 flows。
 */
export function resolveStudioConfig(overrides: Partial<StudioConfig> = {}): StudioConfig {
	return {
		flowsDir: overrides.flowsDir ?? process.env.RR_STUDIO_FLOWS_DIR ?? DEFAULT_FLOWS_DIR,
		artifactsDir:
			overrides.artifactsDir ?? process.env.RR_STUDIO_ARTIFACTS_DIR ?? DEFAULT_ARTIFACTS_DIR,
		profilesDir:
			overrides.profilesDir ?? process.env.RR_STUDIO_PROFILES_DIR ?? DEFAULT_PROFILES_DIR,
	}
}
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

function summarizeStep(step: Step, index: number, flowId?: string): StepSummary {
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
		...(flowId && cropRef ? { screenshot: `/artifacts/${flowId}/${cropRef}` } : {}),
	}
}

export function summarize(flow: Flow): StepSummary[] {
	return flattenSteps(flow.steps).map((step, index) => summarizeStep(step, index, flow.id))
}

/**
 * 录制器写回登录态时：文件已存在且是 Studio wrapper（{origin,savedAt,storageState}）→ 保持 wrapper；
 * 首次创建时录制器写的是**裸 storageState** → 这里转成 wrapper（docs/profiles-rerecord.md §A.1），
 * 否则 /api/profiles 列表读不到（readProfileMeta 只认 wrapper）。
 */
async function normalizeProfileFile(config: StudioConfig, origin: string): Promise<void> {
	const path = profilePathFor(config.profilesDir, origin)
	try {
		const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
		if (raw.storageState && typeof raw.storageState === 'object') return // 已是 wrapper
		if (Array.isArray(raw.cookies)) {
			await writeProfile(config.profilesDir, origin, {
				cookies: raw.cookies,
				origins: Array.isArray(raw.origins) ? raw.origins : [],
			})
		}
	} catch {
		/* 没有 profile / 内容坏：什么都不做 */
	}
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
	/** record = 正常录制（停止后自检）；rerecord = 单步重录的候选录制（停止后返回候选） */
	purpose: 'record' | 'rerecord'
	targetFile?: string
	targetStepId?: string
}

/** 显式"登录/更新登录态"会话（不录制，只负责保存 storageState） */
interface LoginSession {
	id: string
	url: string
	origin: string
	profilesDir: string
	startedAt: number
	browser: Browser
	context: BrowserContext
	timer: NodeJS.Timeout
	closed: boolean
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
const loginSessions = new Map<string, LoginSession>()

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

function flowFileFromName(config: StudioConfig, name: string): string | undefined {
	const safe = safeJoin(config.flowsDir, name)
	if (!safe || !safe.endsWith('.json') || !existsSync(safe)) return undefined
	return safe
}

/* ------------------------------------------------------------------ */
/* 流程相关                                                            */
/* ------------------------------------------------------------------ */

async function listFlows(config: StudioConfig): Promise<Array<Record<string, unknown>>> {
	await mkdir(config.flowsDir, { recursive: true })
	const files = (await readdir(config.flowsDir))
		.filter((f) => f.endsWith('.json') && !f.endsWith('.bak'))
		.sort()
	const out: Array<Record<string, unknown>> = []
	for (const file of files) {
		try {
			const full = join(config.flowsDir, file)
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

async function startRecording(
	config: StudioConfig,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
		purpose: 'record',
	}
	sessions.set(id, session)

	// 登录态：有 profile 就带上；录制停止时自动写回（刷新过期时间/cookie）
	const origin = originOf(url)
	await mkdir(config.profilesDir, { recursive: true }).catch(() => {})
	const storageStatePath = await storageStatePathIfExists(config.profilesDir, origin)
	const options: RecordOptions = {
		startUrl: url,
		outPath: join(config.flowsDir, file),
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
	if (storageStatePath) Object.assign(options, { storageStatePath })
	if (origin)
		Object.assign(options, { saveStorageStatePath: profilePathFor(config.profilesDir, origin) })
	// 录制时让用户自己操作；record() 在 stop 后落盘
	session.promise = record(options)
		.then(async (result) => {
			if (origin) await normalizeProfileFile(config, origin)
			if (!session.cancelled) {
				console.log(`[studio] 录制完成：${file}（${result.flow.steps.length} 步）`)
			}
			return result
		})
		.catch(async (err: Error) => {
			if (origin) await normalizeProfileFile(config, origin)
			console.error(`[studio] 录制失败：${err.message}`)
			return null
		})
	return { sessionId: id }
}

async function stopRecording(
	config: StudioConfig,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const session = sessions.get(String(body.sessionId ?? ''))
	if (!session) throw new Error('录制会话不存在')
	session.controller.abort()
	const result = await session.promise
	if (!result) throw new Error('录制失败（没有产生 flow）')

	// 录制后自检：立刻回放一次（headless），失败步骤标出来
	const selfCheck = await runSelfCheck(result.flow, join(config.flowsDir, session.file))
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
/* 登录态（docs/profiles-rerecord.md §A）                               */
/* ------------------------------------------------------------------ */

async function closeLoginSession(id: string, save: boolean): Promise<ProfileMeta | null> {
	const session = loginSessions.get(id)
	if (!session || session.closed) return null
	session.closed = true
	clearTimeout(session.timer)
	loginSessions.delete(id)
	let meta: ProfileMeta | null = null
	if (save) {
		try {
			const state = await session.context.storageState()
			meta = await writeProfile(session.profilesDir, session.origin, state)
		} catch (err) {
			console.error(`[studio] 保存登录态失败：${(err as Error).message}`)
		}
	}
	await session.browser.close().catch(() => {})
	return meta
}

async function startLoginSession(
	config: StudioConfig,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const url = String(body.url ?? '').trim()
	if (!url) throw new Error('缺少网址 url')
	const origin = originOf(url)
	if (!origin) throw new Error('网址格式不对（需要 http:// 或 https:// 开头）')
	await mkdir(config.profilesDir, { recursive: true }).catch(() => {})
	const storageStatePath = await storageStatePathIfExists(config.profilesDir, origin)
	const browser = await chromium.launch({ headless: false })
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		...(storageStatePath ? { storageState: storageStatePath } : {}),
	})
	const page = await context.newPage()
	await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' }).catch(() => {})
	const id = makeId('login')
	const timer = setTimeout(
		() => {
			void closeLoginSession(id, false)
		},
		10 * 60 * 1000,
	)
	timer.unref?.()
	loginSessions.set(id, {
		id,
		url,
		origin,
		profilesDir: config.profilesDir,
		startedAt: Date.now(),
		browser,
		context,
		timer,
		closed: false,
	})
	return { sessionId: id, origin }
}

async function stopLoginSession(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const id = String(body.sessionId ?? '')
	if (!loginSessions.has(id)) throw new Error('登录会话不存在或已结束')
	const meta = await closeLoginSession(id, true)
	if (!meta) throw new Error('保存登录态失败，请重试')
	console.log(`[studio] 登录态已保存：${meta.origin}（cookie ${meta.cookieCount}）`)
	return { ok: true, profile: meta }
}

async function cancelLoginSession(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const id = String(body.sessionId ?? '')
	await closeLoginSession(id, false)
	return { ok: true }
}

/* ------------------------------------------------------------------ */
/* 单步重录（docs/profiles-rerecord.md §B）                             */
/* ------------------------------------------------------------------ */

/** 在顶层 steps 里找步骤；分组内的步骤暂不支持单步重录 */
function findTopLevelStep(flow: Flow, stepId: string): { step: Step; index: number } {
	const index = flow.steps.findIndex((step) => step.id === stepId)
	if (index < 0) {
		const nested = flattenSteps(flow.steps).some((step) => step.id === stepId)
		if (nested) throw new Error('暂不支持重录分组内的步骤')
		throw new Error('步骤不存在')
	}
	return { step: flow.steps[index]!, index }
}

async function startRerecord(
	config: StudioConfig,
	file: string,
	stepId: string,
): Promise<Record<string, unknown>> {
	const flowFile = flowFileFromName(config, file)
	if (!flowFile) throw new Error('流程文件不存在')
	const flow = await loadFlow(flowFile)
	const { step, index } = findTopLevelStep(flow, stepId)
	const startUrl = flow.meta.env.startUrl
	const id = makeId('rr')
	const tempFile = `.rerecord/${id}.json`
	const tempAbs = join(config.flowsDir, tempFile)
	await mkdir(join(config.flowsDir, '.rerecord'), { recursive: true })

	const controller = new AbortController()
	const session: RecordSession = {
		id,
		url: startUrl,
		title: `重录 ${stepId}`,
		file: tempFile,
		startedAt: Date.now(),
		steps: [],
		controller,
		promise: Promise.resolve(null),
		cancelled: false,
		purpose: 'rerecord',
		targetFile: file,
		targetStepId: stepId,
	}
	sessions.set(id, session)

	const origin = originOf(startUrl)
	const storageStatePath = await storageStatePathIfExists(config.profilesDir, origin)
	const options: RecordOptions = {
		startUrl,
		outPath: tempAbs,
		headless: false,
		stopSignal: controller.signal,
		onStep: (s) => {
			session.steps.push({
				index: session.steps.length,
				id: s.id,
				kind: s.kind,
				title: stepTitle(s),
			})
		},
	}
	if (storageStatePath) Object.assign(options, { storageStatePath })
	if (origin)
		Object.assign(options, { saveStorageStatePath: profilePathFor(config.profilesDir, origin) })
	session.promise = record(options)
		.then(async (result) => {
			if (origin) await normalizeProfileFile(config, origin)
			return result
		})
		.catch(async (err: Error) => {
			if (origin) await normalizeProfileFile(config, origin)
			console.error(`[studio] 单步重录失败：${err.message}`)
			return null
		})
	return {
		sessionId: id,
		startUrl,
		target: { stepId, stepIndex: index, title: stepTitle(step) },
	}
}

async function stopRerecord(
	config: StudioConfig,
	file: string,
	stepId: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const session = sessions.get(String(body.sessionId ?? ''))
	if (!session || session.purpose !== 'rerecord') throw new Error('重录会话不存在')
	if (session.targetFile !== file || session.targetStepId !== stepId)
		throw new Error('重录会话与目标步骤不匹配')
	session.controller.abort()
	await session.promise.catch(() => null)
	const tempAbs = join(config.flowsDir, session.file)
	let candidates: Array<StepSummary & { stepId: string }> = []
	try {
		const tempFlow = await loadFlow(tempAbs)
		candidates = flattenSteps(tempFlow.steps).map((s, index) => ({
			...summarizeStep(s, index),
			stepId: s.id,
		}))
	} catch {
		/* 没有录到任何动作（文件不存在/非法）→ 空候选 */
	}
	sessions.delete(session.id)
	return { candidates, tempFile: session.file }
}

async function cancelRerecord(
	config: StudioConfig,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const session = sessions.get(String(body.sessionId ?? ''))
	if (!session || session.purpose !== 'rerecord') return { ok: true }
	session.cancelled = true
	session.controller.abort()
	await session.promise.catch(() => null)
	await rm(join(config.flowsDir, session.file), { force: true }).catch(() => {})
	sessions.delete(session.id)
	return { ok: true }
}

/** 把候选步骤替换到原流程（保留原 stepId，version+1，写 .bak） */
async function replaceStep(
	config: StudioConfig,
	file: string,
	stepId: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const tempFile = String(body.tempFile ?? '')
	const tempStepId = String(body.tempStepId ?? '')
	if (!/^\.rerecord\/[A-Za-z0-9_.-]+\.json$/.test(tempFile))
		throw new ApiParamError('临时录制文件不合法')
	if (!tempStepId) throw new ApiParamError('缺少要替换的候选步骤')
	const tempFlow = await loadFlow(join(config.flowsDir, tempFile))
	const candidate = flattenSteps(tempFlow.steps).find((step) => step.id === tempStepId)
	if (!candidate) throw new ApiParamError('候选步骤不存在')
	if (candidate.kind === 'group') throw new ApiParamError('不能用一个分组替换单步')
	const next = structuredClone(candidate) as Step
	next.id = stepId // 保留原步骤 id：历史/引用稳定
	const flow = await updateFlow(config, file, (f) => {
		const { index } = findTopLevelStep(f, stepId)
		const prevPage = (f.steps[index] as { page?: { index: number } }).page
		if (prevPage) (next as { page?: { index: number } }).page = prevPage
		f.steps[index] = next
		f.version = f.version + 1
	})
	await rm(join(config.flowsDir, tempFile), { force: true }).catch(() => {})
	return appliedResponse(flow)
}

/* ------------------------------------------------------------------ */
/* 回放                                                                */
/* ------------------------------------------------------------------ */

async function startPlayback(
	config: StudioConfig,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const file = String(body.file ?? '')
	const flowFile = flowFileFromName(config, file)
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
			// 登录态：回放自动带该站点已保存的 cookie/localStorage（docs/profiles-rerecord.md §A.2）
			const playStorage = await storageStatePathIfExists(
				config.profilesDir,
				originOf(flow.meta.env.startUrl),
			)
			const playOptions: Parameters<typeof playRuns>[0] = {
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
			}
			if (playStorage) Object.assign(playOptions, { storageStatePath: playStorage })
			const results: RunResult[] = await playRuns(playOptions)
			job.runs = results.map((r) => ({
				ok: r.ok,
				steps: r.steps.map((s, stepIndex) => ({
					id: s.stepId,
					kind: s.kind,
					status: s.status,
					...(s.level ? { level: s.level } : {}),
					ms: s.ms,
					...(s.error ? { code: s.error.code, reason: reasonOf(s) ?? s.error.message } : {}),
					screenshot: screenshotUrl(config, flow.id, r.runId, stepIndex, s.status),
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
	config: StudioConfig,
	flowId: string,
	runId: string,
	stepIndex: number,
	status: string,
): string | undefined {
	const base = join(config.artifactsDir, flowId, 'runs', runId, String(stepIndex))
	const file = status === 'pass' ? join(base, 'before.png') : join(base, 'after.png')
	if (!existsSync(file)) return undefined
	return `/artifacts/${flowId}/runs/${runId}/${stepIndex}/${status === 'pass' ? 'before' : 'after'}.png`
}

/* ------------------------------------------------------------------ */
/* 编辑                                                                */
/* ------------------------------------------------------------------ */

async function updateFlow(
	config: StudioConfig,
	file: string,
	mutate: (flow: Flow) => void,
): Promise<Flow> {
	const flowFile = flowFileFromName(config, file)
	if (!flowFile) throw new Error('流程文件不存在')
	const flow = await loadFlow(flowFile)
	mutate(flow)
	await saveFlow(flow, flowFile, { backup: true })
	return flow
}

/* ------------------------------------------------------------------ */
/* 参数化建议（docs/parameterization.md §6）                            */
/* ------------------------------------------------------------------ */

/** 请求参数错误（→ 400，与 SuggestError 区分：这是调用方没按契约传参） */
export class ApiParamError extends Error {
	readonly code = 'BAD_REQUEST'
	constructor(message: string) {
		super(message)
		this.name = 'ApiParamError'
	}
}

const SUGGEST_VARIABLE_TYPES: readonly SuggestVariableType[] = [
	'string',
	'text',
	'email',
	'date',
	'number',
]

/** 同一次请求最多处理多少条批量应用（防止误传巨大数组把服务打挂） */
const MAX_BATCH_APPLY = 200

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
	return value as Record<string, unknown>
}

/** 校验并规范化单条 apply 入参（SuggestError 之外的"参数错"在这里拦掉，消息带中文） */
export function parseApplyInput(raw: unknown): ApplySuggestionInput {
	const body = asRecord(raw)
	if (!body) throw new ApiParamError('请求体必须是 JSON 对象')

	const stepId = typeof body.stepId === 'string' ? body.stepId.trim() : ''
	if (!stepId) throw new ApiParamError('缺少 stepId')
	const name = typeof body.name === 'string' ? body.name.trim() : ''
	if (!name) throw new ApiParamError('缺少变量名 name')

	const input: ApplySuggestionInput = { stepId, name }
	if (body.type !== undefined) {
		if (
			typeof body.type !== 'string' ||
			!SUGGEST_VARIABLE_TYPES.includes(body.type as SuggestVariableType)
		) {
			throw new ApiParamError(`type 只能是 ${SUGGEST_VARIABLE_TYPES.join(' / ')}`)
		}
		input.type = body.type as SuggestVariableType
	}
	if (body.applySameValue !== undefined) {
		if (typeof body.applySameValue !== 'boolean') {
			throw new ApiParamError('applySameValue 必须是布尔值')
		}
		input.applySameValue = body.applySameValue
	}
	return input
}

/** 校验批量入参：先整体校验再交给 suggest（任一条非法 → 整个请求 400，不落盘） */
export function parseApplyBatch(raw: unknown): ApplySuggestionInput[] {
	const body = asRecord(raw)
	if (!body) throw new ApiParamError('请求体必须是 JSON 对象')
	if (!Array.isArray(body.apply)) throw new ApiParamError('缺少 apply 数组')
	if (body.apply.length === 0) throw new ApiParamError('apply 不能为空')
	if (body.apply.length > MAX_BATCH_APPLY) {
		throw new ApiParamError(`一次最多应用 ${MAX_BATCH_APPLY} 条建议`)
	}
	return body.apply.map((item, index) => {
		try {
			return parseApplyInput(item)
		} catch (err) {
			throw new ApiParamError(`第 ${index + 1} 条：${(err as Error).message}`)
		}
	})
}

/** `GET .../suggestions` 的 includeWeak 解析：0/1、true/false、yes/no 都认，默认 false */
export function parseIncludeWeak(raw: string | null): boolean {
	const value = (raw ?? '').trim().toLowerCase()
	return value === '1' || value === 'true' || value === 'yes'
}

/** suggest 的纯函数结果 → 写回可变 flow（version 由调用方在 updateFlow 里 +1） */
function applyResultIntoFlow(flow: Flow, result: ApplyResult): void {
	flow.steps = result.flow.steps
	flow.variables = result.flow.variables
}

/** apply 之后的响应体：flow + 步骤摘要 + 重新计算的建议（建议失败不拖垮已成功的写入） */
async function appliedResponse(
	flow: Flow,
): Promise<{ ok: true; flow: Flow; steps: unknown; suggestions: FlowSuggestions | null }> {
	let suggestions: FlowSuggestions | null = null
	try {
		suggestions = analyzeFlow(flow, { includeWeak: false })
	} catch (err) {
		// 规则引擎异常不该让"已经写成功"的请求返回 500；UI 会重新拉 suggestions
		console.error(`[studio] apply 后重算建议失败：${(err as Error).message}`)
	}
	return { ok: true, flow, steps: summarize(flow), suggestions }
}

/** 统一错误映射：SuggestError / 参数错 → 400（带 code），文件不存在 → 404，其余 → 500 */
function sendSuggestError(res: ServerResponse, err: unknown): void {
	if (err instanceof SuggestError) {
		return json(res, 400, { error: err.message, code: err.code })
	}
	if (err instanceof ApiParamError) {
		return json(res, 400, { error: err.message, code: err.code })
	}
	if (err instanceof Error && err.message === '流程文件不存在') {
		return json(res, 404, { error: 'flow 不存在' })
	}
	console.error('[studio] 参数化建议接口失败', err)
	json(res, 500, { error: `内部错误：${(err as Error).message}` })
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(
	config: StudioConfig,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const path = url.pathname
	if (!path.startsWith('/api/')) return false
	const method = req.method ?? 'GET'

	if (path === '/api/config' && method === 'GET') {
		json(res, 200, {
			aiEnabled: Boolean(process.env.RR_AI_ENABLED === '1'),
			flowsDir: config.flowsDir,
			artifactsDir: config.artifactsDir,
		})
		return true
	}
	if (path === '/api/flows' && method === 'GET') {
		json(res, 200, { flows: await listFlows(config) })
		return true
	}
	const flowMatch = /^\/api\/flows\/([^/]+)$/.exec(path)
	if (flowMatch && method === 'GET') {
		const flowFile = flowFileFromName(config, decodeURIComponent(flowMatch[1]!))
		if (!flowFile) return (json(res, 404, { error: 'flow 不存在' }), true)
		const flow = await loadFlow(flowFile)
		json(res, 200, { flow, steps: summarize(flow) })
		return true
	}
	const renameMatch = /^\/api\/flows\/([^/]+)\/rename$/.exec(path)
	if (renameMatch && method === 'POST') {
		const body = await readBody(req)
		const flow = await updateFlow(config, decodeURIComponent(renameMatch[1]!), (f) => {
			f.title = String(body.title ?? f.title)
		})
		json(res, 200, { ok: true, flow })
		return true
	}
	const deleteMatch = /^\/api\/flows\/([^/]+)\/steps\/([^/]+)\/delete$/.exec(path)
	if (deleteMatch && method === 'POST') {
		const flow = await updateFlow(config, decodeURIComponent(deleteMatch[1]!), (f) => {
			f.steps = f.steps.filter((s) => s.id !== deleteMatch[2])
		})
		json(res, 200, { ok: true, flow })
		return true
	}
	const varsMatch = /^\/api\/flows\/([^/]+)\/variables$/.exec(path)
	if (varsMatch && method === 'POST') {
		const body = await readBody(req)
		const next = (body.variables as Array<{ name: string; value?: string }> | undefined) ?? []
		const flow = await updateFlow(config, decodeURIComponent(varsMatch[1]!), (f) => {
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

	// ---- 参数化建议 Phase 1（规则召回 + 一键采纳） ----
	const suggestionsMatch = /^\/api\/flows\/([^/]+)\/suggestions$/.exec(path)
	if (suggestionsMatch && method === 'GET') {
		const flowFile = flowFileFromName(config, decodeURIComponent(suggestionsMatch[1]!))
		if (!flowFile) return (json(res, 404, { error: 'flow 不存在' }), true)
		const flow = await loadFlow(flowFile)
		try {
			json(
				res,
				200,
				analyzeFlow(flow, { includeWeak: parseIncludeWeak(url.searchParams.get('includeWeak')) }),
			)
		} catch (err) {
			sendSuggestError(res, err)
		}
		return true
	}

	const applyOneMatch = /^\/api\/flows\/([^/]+)\/apply-suggestion$/.exec(path)
	if (applyOneMatch && method === 'POST') {
		const file = decodeURIComponent(applyOneMatch[1]!)
		if (!flowFileFromName(config, file)) return (json(res, 404, { error: 'flow 不存在' }), true)
		try {
			// 先校验入参，再进 updateFlow（load → apply → 校验 → saveFlow(.bak)）
			const input = parseApplyInput(await readBody(req))
			const flow = await updateFlow(config, file, (f) => {
				const result = applySuggestion(f, input)
				applyResultIntoFlow(f, result)
				// 无论替换了几步，version 只 +1
				f.version = f.version + 1
			})
			json(res, 200, await appliedResponse(flow))
		} catch (err) {
			sendSuggestError(res, err)
		}
		return true
	}

	const applyManyMatch = /^\/api\/flows\/([^/]+)\/apply-suggestions$/.exec(path)
	if (applyManyMatch && method === 'POST') {
		const file = decodeURIComponent(applyManyMatch[1]!)
		if (!flowFileFromName(config, file)) return (json(res, 404, { error: 'flow 不存在' }), true)
		try {
			// 批量：先整体校验（parseApplyBatch 全量），再一次性 applySuggestions；
			// mutate 抛错时 updateFlow 不会走到 saveFlow，所以文件保持原样
			const inputs = parseApplyBatch(await readBody(req))
			const flow = await updateFlow(config, file, (f) => {
				const result = applySuggestions(f, inputs)
				applyResultIntoFlow(f, result)
				f.version = f.version + 1
			})
			json(res, 200, await appliedResponse(flow))
		} catch (err) {
			sendSuggestError(res, err)
		}
		return true
	}

	const renameVarMatch = /^\/api\/flows\/([^/]+)\/variables\/rename$/.exec(path)
	if (renameVarMatch && method === 'POST') {
		const file = decodeURIComponent(renameVarMatch[1]!)
		if (!flowFileFromName(config, file)) return (json(res, 404, { error: 'flow 不存在' }), true)
		try {
			const body = await readBody(req)
			const from = typeof body.from === 'string' ? body.from.trim() : ''
			const to = typeof body.to === 'string' ? body.to.trim() : ''
			if (!from) throw new ApiParamError('缺少原变量名 from')
			if (!to) throw new ApiParamError('缺少新变量名 to')
			if (from === to) throw new ApiParamError('新旧变量名相同，无需重命名')
			const flow = await updateFlow(config, file, (f) => {
				const next = renameVariable(f, from, to)
				applyResultIntoFlow(f, { flow: next, changedStepIds: [] })
				f.version = f.version + 1
			})
			json(res, 200, { ok: true, flow })
		} catch (err) {
			sendSuggestError(res, err)
		}
		return true
	}

	/* ---------- 登录态（docs/profiles-rerecord.md §A.3） ---------- */

	if (path === '/api/profiles' && method === 'GET') {
		json(res, 200, { profiles: await listProfiles(config.profilesDir) })
		return true
	}
	if (path === '/api/profiles/login/start' && method === 'POST') {
		try {
			json(res, 200, await startLoginSession(config, await readBody(req)))
		} catch (err) {
			json(res, 400, { error: (err as Error).message })
		}
		return true
	}
	if (path === '/api/profiles/login/status' && method === 'GET') {
		const session = loginSessions.get(url.searchParams.get('sessionId') ?? '')
		json(
			res,
			200,
			session ? { running: true, elapsedMs: Date.now() - session.startedAt } : { running: false },
		)
		return true
	}
	if (path === '/api/profiles/login/stop' && method === 'POST') {
		try {
			json(res, 200, await stopLoginSession(await readBody(req)))
		} catch (err) {
			json(res, 400, { error: (err as Error).message })
		}
		return true
	}
	if (path === '/api/profiles/login/cancel' && method === 'POST') {
		try {
			json(res, 200, await cancelLoginSession(await readBody(req)))
		} catch (err) {
			json(res, 400, { error: (err as Error).message })
		}
		return true
	}
	const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(path)
	if (profileMatch && method === 'DELETE') {
		const originKey = decodeURIComponent(profileMatch[1]!)
		const ok = await deleteProfile(config.profilesDir, originKey)
		json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '登录态不存在' })
		return true
	}

	/* ---------- 单步重录（docs/profiles-rerecord.md §B.2） ---------- */

	const rerecordMatch =
		/^\/api\/flows\/([^/]+)\/steps\/([^/]+)\/rerecord\/(start|stop|cancel)$/.exec(path)
	if (rerecordMatch && method === 'POST') {
		const file = decodeURIComponent(rerecordMatch[1]!)
		const stepId = decodeURIComponent(rerecordMatch[2]!)
		const action = rerecordMatch[3]!
		if (!flowFileFromName(config, file)) return (json(res, 404, { error: 'flow 不存在' }), true)
		try {
			const body = await readBody(req)
			if (action === 'start') json(res, 200, await startRerecord(config, file, stepId))
			else if (action === 'stop') json(res, 200, await stopRerecord(config, file, stepId, body))
			else json(res, 200, await cancelRerecord(config, body))
		} catch (err) {
			json(res, 400, { error: (err as Error).message })
		}
		return true
	}
	const replaceMatch = /^\/api\/flows\/([^/]+)\/steps\/([^/]+)\/replace$/.exec(path)
	if (replaceMatch && method === 'POST') {
		const file = decodeURIComponent(replaceMatch[1]!)
		const stepId = decodeURIComponent(replaceMatch[2]!)
		if (!flowFileFromName(config, file)) return (json(res, 404, { error: 'flow 不存在' }), true)
		try {
			json(res, 200, await replaceStep(config, file, stepId, await readBody(req)))
		} catch (err) {
			sendSuggestError(res, err)
		}
		return true
	}

	if (path === '/api/record/start' && method === 'POST') {
		try {
			json(res, 200, await startRecording(config, await readBody(req)))
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
			json(res, 200, await stopRecording(config, await readBody(req)))
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
			json(res, 200, await startPlayback(config, await readBody(req)))
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

export interface StudioServerOptions extends Partial<StudioConfig> {
	/** 0 = 让系统分配随机端口（测试用）；默认读 RR_STUDIO_PORT，再默认 4400 */
	port?: number
}

export function createStudioServer(
	options: StudioServerOptions = {},
): Promise<{ port: number; close: () => Promise<void> }> {
	const config = resolveStudioConfig(options)
	const port = options.port ?? Number(process.env.RR_STUDIO_PORT ?? 4400)
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
			void (async () => {
				try {
					if (await handleApi(config, req, res, url)) return
					if (url.pathname.startsWith('/artifacts/')) {
						const rel = decodeURIComponent(url.pathname.slice('/artifacts/'.length))
						const safe = safeJoin(config.artifactsDir, rel)
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
			console.log(`\n  Studio 已启动：http://127.0.0.1:${actual}\n  数据目录：${config.flowsDir}\n`)
			resolve({ port: actual, close: () => new Promise<void>((r) => server.close(() => r())) })
		})
	})
}
