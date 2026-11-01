/* global window, document, fetch, URL, URLSearchParams, Element, HTMLElement, HTMLInputElement, HTMLImageElement */
'use strict'

/* =========================================================================
 * 流程录制助手 · 本地控制台（纯静态，无框架、无构建、无外部资源）
 *
 * 数据全部来自本地 Node 服务，接口严格按 docs/studio-api.md：
 *   GET  /api/config
 *   GET  /api/flows
 *   GET  /api/flows/:file
 *   POST /api/flows/:file/rename                      { title }
 *   POST /api/flows/:file/steps/:stepId/delete
 *   POST /api/record/start                            { url, title? }
 *   GET  /api/record/status?sessionId=...
 *   POST /api/record/stop                             { sessionId }
 *   POST /api/record/cancel                           { sessionId }
 *   POST /api/play                                    { file, runs?, variables?, headed? }
 *   GET  /api/runs/:runId
 *   POST /api/runs/:runId/stop
 *   截图走相对 URL（如 /artifacts/...）
 *
 * 轮询 500ms；所有失败都转成中文人话展示，不吞错、不刷 console。
 * ========================================================================= */

const POLL_MS = 500

const STATUS_TEXT = {
	pass: '通过',
	fail: '失败',
	skip: '跳过',
	running: '进行中',
	pending: '等待中',
	recorded: '已记录',
}

const KIND_TEXT = {
	navigate: '打开网页',
	click: '点击',
	input: '输入',
	select: '选择',
	key: '按键',
	hover: '悬停',
	scroll: '滚动',
	drag: '拖拽',
	upload: '上传',
	wait: '等待',
	assert: '检查',
	extract: '提取',
	script: '脚本',
	group: '分组',
}

/** 只在后端没给 reason 时兜底；正常情况直接展示后端的人话 reason */
const CODE_TEXT = {
	ELEMENT_NOT_FOUND: '页面上找不到这个元素，可能页面改版了或还没加载完',
	NOT_ACTIONABLE: '找到了元素但暂时点不了（被遮挡 / 不可见 / 未启用）',
	NO_EFFECT: '点了但页面没有反应，可能需要再确认一次',
	EXPECT_MISMATCH: '操作后页面没有出现预期变化',
	NAVIGATION_FAILED: '页面打开失败，检查网址或网络',
	DIALOG_UNEXPECTED: '弹出了意料之外的对话框',
	BROWSER_CRASH: '浏览器异常退出',
	VARIABLE_MISSING: '缺少运行参数（变量未填写）',
}

/** 后端 StepSummary.expect 给的是 kind（如 urlChange），这里只做展示层翻译 */
const EXPECT_TEXT = {
	urlChange: '检查网址是否变化',
	elementVisible: '检查元素是否出现',
	elementHidden: '检查元素是否消失',
	textChange: '检查文字是否更新',
	domSignature: '检查页面结构是否变化',
}

const LEVEL_TEXT = {
	L1: 'L1 语义定位（最稳）',
	L2: 'L2 指纹匹配',
	L3: 'L3 降级定位',
	L4: 'L4 AI 修复',
}

const KNOWN_STATUS = new Set(['pass', 'fail', 'skip', 'running', 'pending'])

const DEFAULT_RECORD_HINT = '点「开始录制」会弹出一个浏览器窗口，你在里面正常操作，每一步都会自动记下来。'
const KNOWN_LEVEL = new Set(['L1', 'L2', 'L3', 'L4'])

/* ------------------------------- 全局状态 ------------------------------- */

const state = {
	config: null,
	flows: [],
	flowsPhase: 'idle', // idle | loading | ready | error
	flowsError: '',
	selectedFile: null,
	detail: null, // { flow, steps }
	detailPhase: 'idle', // idle | loading | ready | error
	detailError: '',
	variables: Object.create(null),
	editingTitle: false,
	recording: null, // { sessionId, steps, elapsedMs, stopping, pollErrorShown }
	selfCheck: null, // { ok, steps, summary, file }
	run: null, // { kind: 'replay'|'selfcheck', runId, data, error, status }
	banner: null,
	lastRecordedCount: 0,
	bottomKey: null,
	varsBuiltKey: null,
	ticker: null,
	busy: Object.create(null),
	lastRunToastKey: null,
}

const dom = {}
const rendered = new WeakMap()

/* -------------------------------- 小工具 -------------------------------- */

function $(id) {
	return document.getElementById(id)
}

function esc(value) {
	const text = value === null || value === undefined ? '' : String(value)
	return text.replace(/[&<>"']/g, (char) => {
		if (char === '&') return '&amp;'
		if (char === '<') return '&lt;'
		if (char === '>') return '&gt;'
		if (char === '"') return '&quot;'
		return '&#39;'
	})
}

/** 只在内容真的变化时才写 DOM，避免轮询把输入框焦点/滚动位置冲掉 */
function setHtml(node, html) {
	if (!node) return
	const next = String(html === null || html === undefined ? '' : html)
	if (rendered.get(node) === next) return
	rendered.set(node, next)
	node.innerHTML = next
}

function fmtMs(ms) {
	const value = Number(ms)
	if (!Number.isFinite(value) || value < 0) return ''
	if (value < 1000) return `${Math.round(value)} ms`
	if (value < 10000) return `${(value / 1000).toFixed(1)} s`
	return `${Math.round(value / 1000)} s`
}

function fmtClock(ms) {
	const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function fmtDuration(ms) {
	const value = Number(ms)
	if (!Number.isFinite(value) || value < 0) return ''
	if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`
	const minutes = Math.floor(value / 60_000)
	const seconds = Math.round((value % 60_000) / 1000)
	return `${minutes} 分 ${seconds} 秒`
}

function fmtDate(iso) {
	if (!iso) return ''
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ''
	const pad = (n) => String(n).padStart(2, '0')
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 后端给的截图是相对 URL，这里统一成浏览器可取的路径 */
function assetUrl(path) {
	if (!path) return ''
	const text = String(path).trim()
	if (!text) return ''
	if (/^https?:\/\//i.test(text)) return text
	if (text.startsWith('/')) return text
	if (text.startsWith('./')) return `/${text.slice(2)}`
	return `/${text}`
}

function humanizeExpect(value) {
	const text = String(value || '')
	return EXPECT_TEXT[text] || text
}

function statusClass(status) {
	const value = String(status || '').toLowerCase()
	return KNOWN_STATUS.has(value) ? value : 'skip'
}

function levelClass(level) {
	const value = String(level || '').toUpperCase()
	return KNOWN_LEVEL.has(value) ? value.toLowerCase() : 'skip'
}

/** 序号兼容 0 基 / 1 基：后端 step.index 是 0 基时 +1 */
function stepNumber(step, index, allSteps) {
	const list = Array.isArray(allSteps) ? allSteps : []
	const base = list.length > 0 && Number(list[0] && list[0].index) === 0 ? 1 : 0
	const own = Number(step && step.index)
	if (Number.isFinite(own)) return own + base
	return index + 1
}

/* -------------------------------- 网络 ---------------------------------- */

async function api(path, options) {
	const opts = options || {}
	const init = { method: opts.method || 'GET', headers: {} }
	if (opts.body !== undefined) {
		init.headers['Content-Type'] = 'application/json'
		init.body = JSON.stringify(opts.body)
	}

	let response
	try {
		response = await fetch(path, init)
	} catch {
		throw new Error('连不上本地服务，请确认控制台程序还在运行（端口没关掉）')
	}

	let text = ''
	try {
		text = await response.text()
	} catch {
		text = ''
	}

	let data = null
	if (text) {
		try {
			data = JSON.parse(text)
		} catch {
			data = null
		}
	}

	if (!response.ok) {
		let message = ''
		if (data && typeof data.error === 'string') message = data.error
		else if (data && data.error && typeof data.error.message === 'string') message = data.error.message
		else if (data && typeof data.message === 'string') message = data.message
		if (!message) message = `服务返回了错误（HTTP ${response.status}）`
		throw new Error(message)
	}

	if (data === null) throw new Error('服务返回的不是有效数据，请重试或重启控制台')
	return data
}

function setBusyButton(button, busy, busyLabel) {
	if (!button) return
	if (busy) {
		if (!button.dataset.idleLabel) button.dataset.idleLabel = button.innerHTML
		button.disabled = true
		button.innerHTML = `<span class="spinner"></span>${esc(busyLabel || '处理中…')}`
		return
	}
	button.disabled = false
	if (button.dataset.idleLabel) {
		button.innerHTML = button.dataset.idleLabel
		delete button.dataset.idleLabel
	}
}

/* ------------------------------- 提示条 --------------------------------- */

function setBanner(banner) {
	state.banner = banner || null
	renderBanner()
}

function showErrorBanner(message, onAction) {
	setBanner({
		type: 'error',
		message: String(message || '出错了'),
		actionLabel: typeof onAction === 'function' ? '重试' : '',
		onAction: typeof onAction === 'function' ? onAction : null,
	})
}

function renderBanner() {
	const host = dom.bannerHost
	if (!host) return
	const banner = state.banner
	if (!banner) {
		setHtml(host, '')
		return
	}
	const type = banner.type === 'warn' || banner.type === 'info' ? banner.type : 'error'
	setHtml(
		host,
		`<div class="banner banner-${type}" role="alert">
			<span class="banner-msg">${esc(banner.message)}</span>
			${banner.actionLabel ? `<button type="button" class="btn btn-small btn-ghost" data-action="banner-action">${esc(banner.actionLabel)}</button>` : ''}
			<button type="button" class="btn-icon" data-action="banner-close" aria-label="关闭提示">✕</button>
		</div>`
	)
}

function toast(message, type) {
	const host = dom.toastHost
	if (!host) return
	const variant = type === 'success' || type === 'error' ? type : 'info'
	while (host.children.length >= 4) host.removeChild(host.firstElementChild)
	const node = document.createElement('div')
	node.className = `toast toast-${variant}`
	node.textContent = String(message === null || message === undefined ? '' : message)
	host.appendChild(node)
	window.setTimeout(() => {
		node.classList.add('toast-out')
		window.setTimeout(() => node.remove(), 260)
	}, 2600)
}

/* -------------------------------- 弹窗 ---------------------------------- */

function confirmDialog(options) {
	const config = options || {}
	const danger = config.danger !== false
	return new Promise((resolve) => {
		const root = dom.modalRoot
		const previousFocus = document.activeElement
		root.innerHTML = `<div class="modal-overlay" data-modal="confirm">
			<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
				<h3 id="modal-title">${esc(config.title || '请确认')}</h3>
				<p class="modal-body">${esc(config.body || '')}</p>
				<div class="modal-actions">
					<button type="button" class="btn btn-ghost" data-modal-action="cancel">${esc(config.cancelText || '取消')}</button>
					<button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal-action="ok">${esc(config.confirmText || '确定')}</button>
				</div>
			</div>
		</div>`

		const overlay = root.querySelector('.modal-overlay')
		const onKey = (event) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				finish(false)
			}
		}
		const finish = (value) => {
			document.removeEventListener('keydown', onKey)
			root.innerHTML = ''
			if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
			resolve(value)
		}
		document.addEventListener('keydown', onKey)
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) finish(false)
		})
		const okButton = root.querySelector('[data-modal-action="ok"]')
		const cancelButton = root.querySelector('[data-modal-action="cancel"]')
		okButton.addEventListener('click', () => finish(true))
		cancelButton.addEventListener('click', () => finish(false))
		// 危险操作的默认焦点放在「取消」上，避免顺手回车误删
		;(danger ? cancelButton : okButton).focus()
	})
}

function openZoom(src, name) {
	const url = String(src || '')
	if (!url) return
	const root = dom.modalRoot
	const previousFocus = document.activeElement
	root.innerHTML = `<div class="modal-overlay" data-modal="zoom">
		<div class="modal-card modal-zoom" role="dialog" aria-modal="true" aria-label="步骤截图">
			<div class="zoom-bar">
				<span class="zoom-name">${esc(name || '步骤截图')}</span>
				<button type="button" class="btn btn-small btn-ghost" data-modal-action="close">关闭</button>
			</div>
			<img src="${esc(url)}" alt="${esc(name || '步骤截图')}" />
		</div>
	</div>`

	const overlay = root.querySelector('.modal-overlay')
	const onKey = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			close()
		}
	}
	const close = () => {
		document.removeEventListener('keydown', onKey)
		root.innerHTML = ''
		if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
	}
	document.addEventListener('keydown', onKey)
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) close()
	})
	const closeButton = root.querySelector('[data-modal-action="close"]')
	if (closeButton) closeButton.addEventListener('click', close)
}

/* ------------------------------ 流程列表 -------------------------------- */

async function loadConfig() {
	try {
		state.config = await api('/api/config')
	} catch (err) {
		state.config = null
		showErrorBanner(err.message, () => {
			loadConfig()
			loadFlows()
		})
	}
	renderFlows()
}

async function loadFlows(options) {
	const opts = options || {}
	if (!opts.silent) state.flowsPhase = 'loading'
	state.flowsError = ''
	renderFlows()

	try {
		const data = await api('/api/flows')
		state.flows = Array.isArray(data.flows) ? data.flows : []
		state.flowsPhase = 'ready'
	} catch (err) {
		state.flowsPhase = 'error'
		state.flowsError = err.message
	}
	renderFlows()
}

function renderFlows() {
	const host = dom.flowsHost
	const meta = dom.flowsMeta
	if (!host) return

	if (state.flowsPhase === 'loading' && state.flows.length === 0) {
		setHtml(meta, '正在加载…')
		setHtml(host, skeletonListHtml())
		return
	}

	if (state.flowsPhase === 'error') {
		setHtml(meta, '')
		setHtml(
			host,
			`<div class="state-block is-error">
				<div class="state-icon">⚠️</div>
				<div class="state-title">流程列表没加载出来</div>
				<div class="state-desc">${esc(state.flowsError)}</div>
				<button type="button" class="btn btn-small btn-ghost" data-action="retry-flows">重试</button>
			</div>`
		)
		return
	}

	if (state.flows.length === 0) {
		setHtml(meta, '')
		setHtml(
			host,
			`<div class="state-block is-center">
				<div class="state-icon">🎬</div>
				<div class="state-title">还没有录制任何流程</div>
				<div class="state-desc">在上面填好要操作的网址，点「开始录制」，然后像平时一样操作一遍，步骤会自动记下来。</div>
			</div>`
		)
		return
	}

	const connected = state.config ? '服务已连接' : '服务连接中…'
	setHtml(meta, `共 ${state.flows.length} 个流程 · ${connected}`)
	setHtml(host, `<ul class="flow-list">${state.flows.map(flowItemHtml).join('')}</ul>`)
}

function flowItemHtml(flow) {
	const file = String(flow.file || '')
	const active = file === state.selectedFile ? ' is-active' : ''
	const metaParts = [`${Number(flow.steps) || 0} 步`]
	const updated = fmtDate(flow.updatedAt)
	if (updated) metaParts.push(`更新于 ${updated}`)
	const version = Number(flow.version) || 1
	const versionChip = version > 1 ? `<span class="chip">第 ${version} 版</span>` : ''
	return `<li class="flow-item${active}">
		<button type="button" class="flow-btn" data-action="select-flow" data-file="${esc(file)}">
			<span class="flow-name"><span>${esc(flow.title || file)}</span>${versionChip}</span>
			<span class="flow-meta">${metaParts.map(esc).join(' · ')}</span>
		</button>
	</li>`
}

function skeletonListHtml() {
	return `<div class="skeleton">${Array.from({ length: 4 }, () => '<div class="skeleton-row"></div>').join('')}</div>`
}

/* ------------------------------ 流程详情 -------------------------------- */

async function selectFlow(file) {
	if (!file) return
	state.selectedFile = file
	state.detail = null
	state.detailPhase = 'loading'
	state.detailError = ''
	state.editingTitle = false
	state.run = null
	state.bottomKey = null
	state.varsBuiltKey = null
	renderAll()

	try {
		const data = await api(`/api/flows/${encodeURIComponent(file)}`)
		if (state.selectedFile !== file) return
		state.detail = { flow: data.flow || {}, steps: Array.isArray(data.steps) ? data.steps : [] }
		state.detailPhase = 'ready'
		state.variables = buildVariables(data.flow)
		try {
			const url = new URL(window.location.href)
			url.searchParams.set('file', file)
			window.history.replaceState(null, '', url)
		} catch {
			/* 深链接不是关键功能，失败忽略 */
		}
	} catch (err) {
		if (state.selectedFile !== file) return
		state.detailPhase = 'error'
		state.detailError = err.message
	}
	renderAll()
}

async function reloadDetail() {
	if (!state.selectedFile) return
	try {
		const data = await api(`/api/flows/${encodeURIComponent(state.selectedFile)}`)
		state.detail = { flow: data.flow || {}, steps: Array.isArray(data.steps) ? data.steps : [] }
		state.detailPhase = 'ready'
		state.detailError = ''
		// 变量默认值不重置，保留用户已经填过的值
	} catch (err) {
		state.detailPhase = 'error'
		state.detailError = err.message
	}
	renderAll()
}

function buildVariables(flow) {
	const defs = flow && Array.isArray(flow.variables) ? flow.variables : []
	const out = Object.create(null)
	for (const variable of defs) {
		if (!variable || !variable.name) continue
		const secret = variable.secret === true || variable.type === 'secret'
		out[variable.name] = secret ? '' : typeof variable.defaultValue === 'string' ? variable.defaultValue : ''
	}
	return out
}

function variableDefs() {
	const flow = state.detail && state.detail.flow
	return flow && Array.isArray(flow.variables) ? flow.variables : []
}

function isSecretVariable(variable) {
	return Boolean(variable) && (variable.secret === true || variable.type === 'secret')
}

/* ------------------------------ 渲染：总入口 ----------------------------- */

function renderAll() {
	renderRecordingChrome()
	renderBanner()
	renderFlows()
	renderDetailHeader()
	renderTimeline()
	renderBottom()
}

function renderRecordingChrome() {
	const recording = state.recording
	if (dom.startBtn) dom.startBtn.hidden = Boolean(recording)
	if (dom.stopBtn) dom.stopBtn.hidden = !recording
	if (dom.cancelBtn) dom.cancelBtn.hidden = !recording
	if (dom.recordClock) dom.recordClock.hidden = !recording
	if (dom.urlInput) dom.urlInput.disabled = Boolean(recording)
	if (dom.titleInput) dom.titleInput.disabled = Boolean(recording)
	if (dom.flowsPane) dom.flowsPane.classList.toggle('is-locked', Boolean(recording))
	document.body.classList.toggle('is-recording', Boolean(recording))

	if (dom.recordHint) {
		if (recording) {
			dom.recordHint.textContent = '正在录制：请切到新打开的浏览器窗口操作，每一步都会自动记录。'
			dom.recordHint.classList.remove('is-error')
		} else if (dom.recordHint.textContent !== DEFAULT_RECORD_HINT) {
			dom.recordHint.textContent = DEFAULT_RECORD_HINT
		}
	}

	if (!recording) {
		if (dom.startBtn) dom.startBtn.disabled = false
		return
	}
	const stopping = Boolean(recording.stopping)
	if (dom.stopBtn) dom.stopBtn.disabled = stopping
	if (dom.cancelBtn) dom.cancelBtn.disabled = stopping
	if (dom.recordClock) dom.recordClock.classList.toggle('is-saving', stopping)
	if (dom.recordClockText) {
		dom.recordClockText.textContent = stopping ? '正在保存并自检…' : `录制中 ${fmtClock(recording.elapsedMs)}`
	}
}

function renderDetailHeader() {
	const host = dom.detailHeader
	if (!host) return

	if (state.recording) {
		const recording = state.recording
		const count = recording.steps.length
		const stopping = Boolean(recording.stopping)
		setHtml(
			host,
			`<div class="detail-title-row">
				<h2>${stopping ? '正在保存并自检…' : '正在录制…'}</h2>
				<span class="chip ${stopping ? 'chip-running' : 'chip-recorded'}">${stopping ? '保存中' : '录制中'}</span>
			</div>
			<p class="detail-sub">${
				stopping
					? '正在保存流程文件，并自动在后台试跑一次，检查每一步能不能走通，请稍候。'
					: `在打开的浏览器里正常操作，每一步都会出现在下面。已记录 ${count} 步，完成后点上面的「停止并保存」。`
			}</p>`
		)
		return
	}

	if (!state.selectedFile) {
		setHtml(
			host,
			`<div class="detail-title-row"><h2>还没有选择流程</h2></div>
			<p class="detail-sub">点左侧任意一个流程查看步骤，或者在上面填网址开始录制一个新流程。</p>`
		)
		return
	}

	if (state.detailPhase === 'loading') {
		setHtml(
			host,
			`<div class="detail-title-row"><h2>正在读取流程…</h2><span class="spinner"></span></div>
			<p class="detail-sub">${esc(state.selectedFile)}</p>`
		)
		return
	}

	if (state.detailPhase === 'error') {
		setHtml(
			host,
			`<div class="detail-title-row"><h2>流程没读出来</h2></div>
			<p class="detail-sub">${esc(state.detailError)}</p>
			<div class="detail-actions is-left">
				<button type="button" class="btn btn-small btn-ghost" data-action="reload-detail">重试</button>
			</div>`
		)
		return
	}

	const detail = state.detail
	if (!detail) return
	const flow = detail.flow || {}
	const steps = Array.isArray(detail.steps) ? detail.steps : []

	if (state.editingTitle) {
		setHtml(
			host,
			`<div class="detail-title-row">
				<input id="rename-input" class="rename-input" type="text" maxlength="60" value="${esc(flow.title || '')}" aria-label="新的流程名字" />
				<button type="button" class="btn btn-small btn-primary" data-action="save-rename">保存</button>
				<button type="button" class="btn btn-small btn-ghost" data-action="cancel-rename">取消</button>
			</div>
			<p class="detail-sub">只改名字，不影响已经录好的步骤。</p>`
		)
		const input = $(`rename-input`)
		if (input) {
			input.focus()
			input.select()
		}
		return
	}

	const version = Number(flow.version) || 1
	setHtml(
		host,
		`<div class="detail-title-row">
			<h2>${esc(flow.title || state.selectedFile)}</h2>
			${version > 1 ? `<span class="chip">第 ${version} 版</span>` : ''}
			<div class="detail-actions">
				<button type="button" class="btn btn-small btn-ghost" data-action="begin-rename">重命名</button>
				<button type="button" class="btn btn-small btn-ghost" data-action="reload-detail" title="重新读取流程文件">重新加载</button>
			</div>
		</div>
		<p class="detail-sub"><span>共 ${steps.length} 步</span><span>文件 ${esc(state.selectedFile)}</span></p>`
	)
}

/* ------------------------------ 步骤时间线 ------------------------------ */

function stepTitleMaps() {
	const steps = state.detail && Array.isArray(state.detail.steps) ? state.detail.steps : []
	const byId = new Map()
	const noById = new Map()
	steps.forEach((step, index) => {
		if (!step || !step.id) return
		byId.set(step.id, step)
		noById.set(step.id, stepNumber(step, index, steps))
	})
	return { steps, byId, noById }
}

/** 回放/自检结果覆盖到时间线上：同一步多轮取最差状态 */
function timelineResults() {
	const map = new Map()
	const rank = (status) => (status === 'fail' ? 3 : status === 'skip' ? 2 : 1)

	if (state.run && state.run.data && state.run.data.file === state.selectedFile) {
		const runs = Array.isArray(state.run.data.runs) ? state.run.data.runs : []
		for (const oneRun of runs) {
			const steps = Array.isArray(oneRun.steps) ? oneRun.steps : []
			for (const step of steps) {
				if (!step || !step.id) continue
				const current = map.get(step.id)
				if (!current || rank(step.status) > rank(current.status)) map.set(step.id, step)
			}
		}
		return map
	}

	const selfCheck = state.selfCheck
	if (selfCheck && selfCheck.file === state.selectedFile && Array.isArray(selfCheck.steps)) {
		for (const step of selfCheck.steps) {
			if (!step || !step.id) continue
			map.set(step.id, { id: step.id, status: step.status, level: step.level, reason: step.reason })
		}
	}
	return map
}

function renderTimeline() {
	const host = dom.timeline
	if (!host) return

	if (state.recording) {
		const steps = state.recording.steps
		if (!steps.length) {
			setHtml(
				host,
				state.recording.stopping
					? `<div class="state-block is-center"><span class="spinner"></span><div class="state-title">正在保存…</div><div class="state-desc">流程文件保存好之后会自动试跑一次自检。</div></div>`
					: `<div class="state-block is-center">
						<div class="state-icon">🔴</div>
						<div class="state-title">还没有记录到步骤</div>
						<div class="state-desc">切到新打开的浏览器窗口，像平时一样点击、输入，每一步会自动出现在这里。</div>
					</div>`
			)
			return
		}
		setHtml(
			host,
			steps.map((step, index) => stepRowHtml(step, index, steps, null, false)).join('')
		)
		if (steps.length > state.lastRecordedCount) {
			state.lastRecordedCount = steps.length
			host.scrollTop = host.scrollHeight
		}
		return
	}

	state.lastRecordedCount = 0

	if (!state.selectedFile) {
		setHtml(
			host,
			`<div class="state-block is-center">
				<div class="state-icon">👈</div>
				<div class="state-title">从左边选一个流程</div>
				<div class="state-desc">选中后这里会显示每一步做了什么；也可以直接在上面录制一个新流程。</div>
			</div>`
		)
		return
	}

	if (state.detailPhase === 'loading') {
		setHtml(host, skeletonListHtml())
		return
	}

	if (state.detailPhase === 'error') {
		setHtml(
			host,
			`<div class="state-block is-error">
				<div class="state-icon">⚠️</div>
				<div class="state-title">步骤没读出来</div>
				<div class="state-desc">${esc(state.detailError)}</div>
				<button type="button" class="btn btn-small btn-ghost" data-action="reload-detail">重试</button>
			</div>`
		)
		return
	}

	const steps = state.detail && Array.isArray(state.detail.steps) ? state.detail.steps : []
	if (!steps.length) {
		setHtml(
			host,
			`<div class="state-block is-center"><div class="state-icon">📄</div><div class="state-title">这个流程里还没有步骤</div><div class="state-desc">可以重新录制一次，或者在左侧换一个流程。</div></div>`
		)
		return
	}

	const results = timelineResults()
	setHtml(host, steps.map((step, index) => stepRowHtml(step, index, steps, results, true)).join(''))
}

function stepRowHtml(step, index, allSteps, results, allowDelete) {
	const item = step || {}
	const result = results ? results.get(item.id) : null
	const recording = Boolean(state.recording)
	const status = result && result.status ? String(result.status) : recording ? 'recorded' : ''
	const no = stepNumber(item, index, allSteps)
	const title = item.title || `第 ${no} 步`
	const kindText = KIND_TEXT[item.kind] || (item.kind ? String(item.kind) : '')
	const level = result && result.level ? String(result.level).toUpperCase() : ''
	const ms = result && result.ms !== undefined && result.ms !== null ? result.ms : null
	const reason = result && result.reason ? String(result.reason) : ''
	const fallbackReason =
		result && result.status === 'fail' && !reason && result.code
			? CODE_TEXT[String(result.code)] || ''
			: ''
	const displayReason = reason || fallbackReason
	const code = result && result.code ? String(result.code) : ''
	const thumb = assetUrl(item.screenshot || (result && result.screenshot) || '')
	const description =
		item.description && item.description !== item.title ? String(item.description) : ''
	const expect = item.expect ? String(item.expect) : ''

	const badges = []
	if (kindText) badges.push(`<span class="chip chip-kind">${esc(kindText)}</span>`)
	if (level) {
		badges.push(
			`<span class="chip chip-${levelClass(level)}" title="${esc(LEVEL_TEXT[level] || level)}">${esc(level)}</span>`
		)
	}
	if (status) {
		const text = STATUS_TEXT[status] || (status === 'recorded' ? '已记录' : status)
		badges.push(`<span class="chip chip-${statusClass(status)}">${esc(text)}</span>`)
	}
	if (code) badges.push(`<span class="chip chip-code" title="错误码">${esc(code)}</span>`)

	const reasonHtml = displayReason
		? `<div class="step-reason">${esc(displayReason)}</div>${
				status === 'fail' && !recording
					? '<div class="step-reason-hint">可以删掉这一步，重新录制一次流程</div>'
					: ''
			}`
		: ''

	return `<div class="step-row step-${status ? statusClass(status) : 'plain'}" data-step-id="${esc(item.id || '')}">
		<div class="step-no">${no}</div>
		<div class="step-main">
			<div class="step-title">${esc(title)}</div>
			${description ? `<div class="step-desc">${esc(description)}</div>` : ''}
			${expect ? `<div class="step-expect" title="原始校验点：${esc(expect)}">校验点：${esc(humanizeExpect(expect))}</div>` : ''}
			${reasonHtml}
		</div>
		<div class="step-side">
			${badges.length ? `<div class="step-badges">${badges.join('')}</div>` : ''}
			${ms !== null ? `<span class="step-ms">${fmtMs(ms)}</span>` : ''}
		</div>
		<div class="step-extras">
			${thumb ? `<button type="button" class="thumb-btn" data-action="zoom" data-src="${esc(thumb)}" data-name="第 ${no} 步 ${esc(title)}" aria-label="查看这一步的截图"><img src="${esc(thumb)}" alt="" loading="lazy" /></button>` : ''}
			${allowDelete && item.id ? `<button type="button" class="btn btn-tiny btn-ghost" data-action="delete-step" data-step-id="${esc(item.id)}">删除</button>` : ''}
		</div>
	</div>`
}

/* ---------------------------- 回放 / 自检面板 --------------------------- */

function renderBottom() {
	const host = dom.bottomPanel
	if (!host) return

	if (!state.detail && !state.recording) {
		if (state.bottomKey !== null) {
			state.bottomKey = null
			state.varsBuiltKey = null
			rendered.delete(host)
		}
		setHtml(
			host,
			`<div class="state-block">
				<div class="state-icon">🧩</div>
				<div class="state-title">先选一个流程，或录制一个新流程</div>
				<div class="state-desc">选中流程后，这里可以填写运行参数并一键回放；录制结束时也会自动试跑一次自检。</div>
			</div>`
		)
		return
	}

	const signature = state.recording
		? `rec:${state.recording.sessionId}`
		: `flow:${state.selectedFile}:${variableDefs()
				.map((v) => `${v && v.name}:${isSecretVariable(v) ? 's' : 'p'}`)
				.join(',')}`

	if (state.bottomKey !== signature) {
		state.bottomKey = signature
		host.innerHTML = bottomShellHtml()
		rendered.delete(host)
	}

	renderVarsHost()
	renderRunHost()
	updatePlayControls()
}

function bottomShellHtml() {
	return `<div class="panel-head">
		<h2>回放</h2>
		<span id="bottom-sub" class="panel-sub"></span>
		<div class="panel-actions">
			<label class="select-wrap" title="连续跑几次，检查流程是否稳定">次数
				<select id="runs-select">
					<option value="1" selected>1 次</option>
					<option value="3">3 次</option>
					<option value="5">5 次</option>
				</select>
			</label>
			<label class="check" title="回放时弹出浏览器窗口，可以看着它操作">
				<input type="checkbox" id="headed-check" checked /> 显示浏览器窗口
			</label>
			<button id="btn-play" class="btn btn-primary" type="button" data-action="play">▶ 开始回放</button>
			<button id="btn-selfcheck" class="btn btn-ghost" type="button" data-action="selfcheck" title="后台静默跑一遍，不打开窗口">✓ 自检</button>
		</div>
	</div>
	<div id="vars-host" class="vars-host"></div>
	<div id="run-host" class="run-host"></div>`
}

function renderVarsHost() {
	const host = $('vars-host')
	if (!host) return

	if (state.recording) {
		setHtml(
			host,
			`<p class="vars-hint">${
				state.recording.stopping
					? '正在保存流程文件并自动自检，请稍候（通常几秒到十几秒）。'
					: '录制中：点「停止并保存」后会自动试跑一次自检，检查每一步是否还能走通。'
			}</p>`
		)
		return
	}

	const defs = variableDefs()
	if (!defs.length) {
		setHtml(host, '<p class="vars-hint">这个流程不需要填写参数，直接点「开始回放」。</p>')
		state.varsBuiltKey = state.bottomKey
		return
	}

	const buildKey = `${state.bottomKey}|${defs.map((v) => (v && v.name) || '').join(',')}`
	setHtml(
		host,
		`<div class="vars"><span class="vars-title">运行参数</span>${defs.map(varFieldHtml).join('')}</div>
		<p class="vars-hint">这些值只用于本次回放，不会被保存。</p>`
	)

	if (state.varsBuiltKey !== buildKey) {
		state.varsBuiltKey = buildKey
		host.querySelectorAll('input[data-var]').forEach((input) => {
			const name = input.getAttribute('data-var') || ''
			input.value = state.variables[name] || ''
		})
	}
}

function varFieldHtml(variable) {
	const item = variable || {}
	const name = String(item.name || '')
	const secret = isSecretVariable(item)
	const hasDefault = !secret && typeof item.defaultValue === 'string' && item.defaultValue !== ''
	const note = secret ? '输入时隐藏' : hasDefault ? '已按默认值填好，可修改' : '必填'
	const chip = secret ? '<span class="chip chip-kind">保密</span>' : ''
	const toggle = secret
		? `<button type="button" class="btn-eye" data-action="toggle-secret" data-target="${esc(name)}" aria-label="显示或隐藏 ${esc(name)}">显示</button>`
		: ''
	return `<div class="var-item">
		<span class="var-label"><code>${esc(name)}</code>${chip}<span>${esc(note)}</span></span>
		<span class="var-input-row">
			<input type="${secret ? 'password' : 'text'}" data-var="${esc(name)}" ${secret ? 'data-secret="1"' : ''} autocomplete="off" spellcheck="false" placeholder="${secret ? '请输入' : ''}" aria-label="${esc(name)}" />
			${toggle}
		</span>
	</div>`
}

function renderRunHost() {
	const host = $('run-host')
	if (!host) return

	if (state.recording) {
		setHtml(
			host,
			state.recording.stopping
				? '<div class="result-card"><div class="loading-line"><span class="spinner"></span>正在保存并自动试跑一次，稍等…</div></div>'
				: ''
		)
		return
	}

	if (!state.detail) {
		setHtml(host, '')
		return
	}

	if (state.run) {
		setHtml(host, runCardHtml())
		return
	}

	if (state.selfCheck) {
		setHtml(host, selfCheckHtml(state.selfCheck))
		return
	}

	setHtml(
		host,
		`<div class="state-block state-inline">
			<div class="state-title">还没有跑过</div>
			<div class="state-desc">点「开始回放」让流程自动跑一遍；每一步都会显示状态，失败时会写清楚原因。</div>
		</div>`
	)
}

function updatePlayControls() {
	const play = $('btn-play')
	const selfCheck = $('btn-selfcheck')
	const runs = $('runs-select')
	const headed = $('headed-check')
	const running =
		Boolean(state.recording) ||
		Boolean(state.run && (state.run.status === 'starting' || state.run.status === 'running'))
	const hasFlow = Boolean(state.detail) && !state.recording

	if (play) play.disabled = running || !hasFlow
	if (selfCheck) selfCheck.disabled = running || !hasFlow
	if (runs) runs.disabled = running
	if (headed) headed.disabled = running

	const recording = Boolean(state.recording)
	for (const node of [play, selfCheck]) {
		if (node) node.hidden = recording
	}
	for (const node of [runs, headed]) {
		const wrap = node ? node.closest('.select-wrap, .check') : null
		if (wrap) wrap.hidden = recording
	}

	const sub = $('bottom-sub')
	if (!sub) return
	let text = ''
	if (state.recording) text = ''
	else if (state.run && state.run.status === 'running') text = '正在回放，下面会实时显示每一步结果'
	else if (state.run && state.run.data) text = state.run.kind === 'selfcheck' ? '最近一次自检结果' : '最近一次回放结果'
	else if (state.selfCheck) text = `最近一次自检：${state.selfCheck.ok ? '通过' : '有失败'}`
	else if (state.detail) text = `共 ${state.detail.steps.length} 步`
	setHtml(sub, esc(text))
}

function runCardHtml() {
	const run = state.run
	const kindText = run.kind === 'selfcheck' ? '自检' : '回放'

	if (run.status === 'starting') {
		return `<div class="result-card"><div class="loading-line"><span class="spinner"></span>正在启动${kindText}…</div></div>`
	}

	if (run.error) {
		return `<div class="result-card is-fail">
			<div class="result-head">
				<span class="chip chip-fail">没跑起来</span>
				<span class="result-title">${kindText}没启动成功</span>
			</div>
			<p class="result-summary">${esc(run.error)}</p>
			<div class="result-actions">
				<button type="button" class="btn btn-small btn-ghost" data-action="play">再试一次</button>
			</div>
		</div>`
	}

	const data = run.data
	if (!data) {
		return `<div class="result-card"><div class="loading-line"><span class="spinner"></span>正在读取${kindText}进度…</div></div>`
	}

	const runs = Array.isArray(data.runs) ? data.runs : []
	const running = data.status === 'running'
	const totals = { pass: 0, fail: 0, total: 0, ms: 0 }
	for (const oneRun of runs) {
		const steps = Array.isArray(oneRun.steps) ? oneRun.steps : []
		totals.total += steps.length
		for (const step of steps) {
			if (step.status === 'pass') totals.pass += 1
			else if (step.status === 'fail') totals.fail += 1
			if (Number.isFinite(Number(step.ms))) totals.ms += Number(step.ms)
		}
	}
	const allOk = runs.length > 0 && runs.every((oneRun) => oneRun.ok)

	let statusChip
	if (running) statusChip = '<span class="chip chip-running">运行中</span>'
	else if (data.status === 'error') statusChip = '<span class="chip chip-fail">出错</span>'
	else if (allOk) statusChip = '<span class="chip chip-pass">全部通过</span>'
	else statusChip = '<span class="chip chip-fail">有失败</span>'

	const cardClass = running ? '' : data.status === 'error' || !allOk ? ' is-fail' : ' is-pass'

	const metaParts = []
	if (runs.length) metaParts.push(`共 ${runs.length} 轮`)
	if (!running) {
		metaParts.push(`${totals.pass}/${totals.total} 步通过`)
		if (totals.ms > 0) metaParts.push(`用时 ${fmtDuration(totals.ms)}`)
	}
	const message = data.message ? String(data.message) : ''
	const messageHtml = message
		? `<p class="result-summary">${esc(message)}</p>`
		: !running && data.status === 'error'
			? '<p class="result-summary">回放过程出错了，具体原因见下面的步骤。</p>'
			: ''

	const blocks = runs.map((oneRun, index) => runBlockHtml(oneRun, index, running)).join('')
	const flowTitle =
		state.detail && state.detail.flow && state.detail.flow.title
			? String(state.detail.flow.title)
			: ''
	const sameFlow = data.file ? data.file === state.selectedFile : true
	const resultTitle = sameFlow && flowTitle ? flowTitle : data.file || state.selectedFile || ''

	return `<div class="result-card${cardClass}">
		<div class="result-head">
			${statusChip}
			<span class="result-title">${esc(resultTitle)} · ${kindText}结果</span>
			<span class="result-meta">${metaParts.map(esc).join(' · ')}</span>
			${running ? '<button type="button" class="btn btn-small btn-ghost" data-action="stop-run">停止</button>' : ''}
		</div>
		${messageHtml}
		${blocks || (running ? '<div class="loading-line is-spaced"><span class="spinner"></span>正在等待第一步结果…</div>' : '')}
	</div>`
}

function runBlockHtml(oneRun, index, running) {
	const steps = Array.isArray(oneRun && oneRun.steps) ? oneRun.steps : []
	const maps = stepTitleMaps()
	const passCount = steps.filter((step) => step.status === 'pass').length
	let totalMs = 0
	for (const step of steps) if (Number.isFinite(Number(step.ms))) totalMs += Number(step.ms)
	const chip = oneRun && oneRun.ok ? '<span class="chip chip-pass">通过</span>' : running ? '' : '<span class="chip chip-fail">有失败</span>'
	const multi = Boolean(state.run && state.run.data && Array.isArray(state.run.data.runs) && state.run.data.runs.length > 1)
	return `<div class="run-block">
		<div class="run-block-head">
			${multi ? `<span>第 ${index + 1} 轮</span>` : '<span>本次结果</span>'}
			${chip}
			<span>${passCount}/${steps.length} 步通过</span>
			${totalMs > 0 ? `<span>${fmtMs(totalMs)}</span>` : ''}
			${running && !(oneRun && oneRun.ok) ? '<span class="spinner"></span>' : ''}
		</div>
		${steps.map((step, stepIndex) => resultStepHtml(step, stepIndex, maps)).join('')}
	</div>`
}

function resultStepHtml(step, index, maps) {
	const item = step || {}
	const known = item.id && maps.byId.has(item.id) ? maps.byId.get(item.id) : null
	const no = item.id && maps.noById.has(item.id) ? maps.noById.get(item.id) : index + 1
	const title = known && known.title ? known.title : item.id ? `第 ${no} 步` : '未命名步骤'
	const status = item.status ? String(item.status) : ''
	const reason = item.reason ? String(item.reason) : ''
	const fallback =
		status === 'fail' && !reason && item.code ? CODE_TEXT[String(item.code)] || '' : ''
	const displayReason = reason || fallback
	const level = item.level ? String(item.level).toUpperCase() : ''
	const thumb = assetUrl(item.screenshot)
	const chips = []
	if (level) {
		chips.push(
			`<span class="chip chip-${levelClass(level)}" title="${esc(LEVEL_TEXT[level] || level)}">${esc(level)}</span>`
		)
	}
	if (status) {
		chips.push(
			`<span class="chip chip-${statusClass(status)}">${esc(STATUS_TEXT[status] || status)}</span>`
		)
	}
	if (item.code) chips.push(`<span class="chip chip-code" title="错误码">${esc(item.code)}</span>`)
	if (Number.isFinite(Number(item.ms))) chips.push(`<span class="step-ms">${fmtMs(item.ms)}</span>`)

	return `<div class="result-step">
		<span class="result-step-no">${no}</span>
		<div class="result-step-main">
			<div class="result-step-title">${esc(title)}</div>
			${displayReason ? `<div class="result-step-reason">${esc(displayReason)}</div>` : ''}
		</div>
		<div class="result-step-side">
			${chips.join('')}
			${
				thumb
					? `<button type="button" class="thumb-btn" data-action="zoom" data-src="${esc(thumb)}" data-name="第 ${no} 步 失败截图" aria-label="查看失败截图"><img src="${esc(thumb)}" alt="" loading="lazy" /></button>`
					: ''
			}
		</div>
	</div>`
}

function selfCheckHtml(selfCheck) {
	const maps = stepTitleMaps()
	const steps = Array.isArray(selfCheck.steps) ? selfCheck.steps : []
	const ok = selfCheck.ok === true
	const failed = steps.filter((step) => step && step.status === 'fail')

	const failItems = failed
		.map((step) => {
			const known = step.id && maps.byId.has(step.id) ? maps.byId.get(step.id) : null
			const no = step.id && maps.noById.has(step.id) ? maps.noById.get(step.id) : ''
			const title = known && known.title ? known.title : step.id ? `第 ${no} 步` : '某一步'
			const reason = step.reason ? String(step.reason) : CODE_TEXT[String(step.code || '')] || '这一步没能走通'
			const level = step.level ? String(step.level).toUpperCase() : ''
			return `<li class="fail-item">
				<div class="fail-item-head">
					${no !== '' ? `<span class="chip chip-fail">第 ${no} 步</span>` : ''}
					<span>${esc(title)}</span>
					${level ? `<span class="chip chip-${levelClass(level)}">${esc(level)}</span>` : ''}
				</div>
				<div class="fail-item-reason">${esc(reason)}</div>
			</li>`
		})
		.join('')

	const allItems = steps
		.map((step, index) => {
			const known = step.id && maps.byId.has(step.id) ? maps.byId.get(step.id) : null
			const no = step.id && maps.noById.has(step.id) ? maps.noById.get(step.id) : index + 1
			const title = known && known.title ? known.title : `第 ${no} 步`
			const status = step.status ? String(step.status) : ''
			const level = step.level ? String(step.level).toUpperCase() : ''
			const reason = step.reason
				? String(step.reason)
				: status === 'fail'
					? CODE_TEXT[String(step.code || '')] || ''
					: ''
			return `<div class="result-step">
				<span class="result-step-no">${no}</span>
				<div class="result-step-main">
					<div class="result-step-title">${esc(title)}</div>
					${reason ? `<div class="result-step-reason">${esc(reason)}</div>` : ''}
				</div>
				<div class="result-step-side">
					${level ? `<span class="chip chip-${levelClass(level)}">${esc(level)}</span>` : ''}
					${status ? `<span class="chip chip-${statusClass(status)}">${esc(STATUS_TEXT[status] || status)}</span>` : ''}
				</div>
			</div>`
		})
		.join('')

	const summary = selfCheck.summary ? String(selfCheck.summary) : ''
	return `<div class="result-card ${ok ? 'is-pass' : 'is-fail'}">
		<div class="result-head">
			<span class="chip ${ok ? 'chip-pass' : 'chip-fail'}">${ok ? '自检通过' : '自检没通过'}</span>
			<span class="result-title">保存后的自动自检</span>
			<span class="result-meta">共 ${steps.length} 步${failed.length ? ` · ${failed.length} 步没通过` : ''}</span>
		</div>
		${summary ? `<p class="result-summary">${esc(summary)}</p>` : ''}
		${failed.length ? `<ul class="result-fail-list">${failItems}</ul>` : ''}
		${
			!ok && failed.length
				? '<p class="vars-hint">建议：把没通过的步骤删掉，再重新录制一次流程；或者确认页面是否改版了。</p>'
				: ''
		}
		${allItems ? `<details class="details-toggle"><summary>查看全部 ${steps.length} 步</summary>${allItems}</details>` : ''}
	</div>`
}

/* -------------------------------- 录制 ---------------------------------- */

function normalizeUrl(raw) {
	const text = String(raw || '').trim()
	if (!text) return null

	let candidate = text
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
		const looksLocal =
			/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(candidate) ||
			/^(10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/|$)/.test(candidate) ||
			/^192\.168\.\d{1,3}\.\d{1,3}(:\d+)?(\/|$)/.test(candidate) ||
			/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?(\/|$)/.test(candidate)
		candidate = `${looksLocal ? 'http' : 'https'}://${candidate}`
	}

	try {
		const url = new URL(candidate)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
		if (!url.hostname) return null
		return url.href
	} catch {
		return null
	}
}

function showUrlError(message) {
	if (dom.recordHint) {
		dom.recordHint.textContent = message
		dom.recordHint.classList.add('is-error')
	}
	if (dom.urlInput) dom.urlInput.classList.add('is-invalid')
}

function clearUrlError() {
	if (dom.recordHint) {
		dom.recordHint.textContent = DEFAULT_RECORD_HINT
		dom.recordHint.classList.remove('is-error')
	}
	if (dom.urlInput) dom.urlInput.classList.remove('is-invalid')
}

async function startRecording() {
	if (state.recording) return
	clearUrlError()

	const raw = dom.urlInput ? dom.urlInput.value.trim() : ''
	if (!raw) {
		showUrlError('请先填要录制的网址，比如 https://example.com/login')
		if (dom.urlInput) dom.urlInput.focus()
		return
	}
	const url = normalizeUrl(raw)
	if (!url) {
		showUrlError('这个网址看起来不对，请填完整网址（http:// 或 https:// 开头，例如 https://example.com/login）')
		if (dom.urlInput) dom.urlInput.focus()
		return
	}

	setBusyButton(dom.startBtn, true, '正在启动…')
	try {
		const payload = { url }
		const title = dom.titleInput ? dom.titleInput.value.trim() : ''
		if (title) payload.title = title
		const result = await api('/api/record/start', { method: 'POST', body: payload })
		if (!result || !result.sessionId) throw new Error('后端没有返回录制会话号')

		state.recording = {
			sessionId: String(result.sessionId),
			steps: [],
			elapsedMs: 0,
			stopping: false,
			pollErrorShown: false,
		}
		state.selfCheck = null
		state.run = null
		state.lastRecordedCount = 0
		setBanner(null)
		toast('开始录制：请在新弹出的浏览器窗口里正常操作', 'success')
		renderAll()
		updateTicker()
	} catch (err) {
		showErrorBanner(`开始录制失败：${err.message}`, () => startRecording())
	} finally {
		setBusyButton(dom.startBtn, false)
		if (dom.startBtn) dom.startBtn.disabled = Boolean(state.recording)
	}
}

async function stopRecording() {
	const recording = state.recording
	if (!recording || recording.stopping) return

	recording.stopping = true
	setBusyButton(dom.stopBtn, true, '正在保存…')
	renderAll()

	try {
		const result = await api('/api/record/stop', {
			method: 'POST',
			body: { sessionId: recording.sessionId },
		})
		const file = result && result.file ? String(result.file) : ''
		state.recording = null
		state.selfCheck =
			result && result.selfCheck
				? {
						ok: result.selfCheck.ok === true,
						steps: Array.isArray(result.selfCheck.steps) ? result.selfCheck.steps : [],
						summary: result.selfCheck.summary || '',
						file,
					}
				: null
		setBanner(null)
		toast('已保存，并自动试跑了一次自检', 'success')
		await loadFlows({ silent: true })
		if (file) await selectFlow(file)
		else renderAll()
	} catch (err) {
		recording.stopping = false
		showErrorBanner(`保存失败：${err.message}`, () => stopRecording())
		renderAll()
	} finally {
		setBusyButton(dom.stopBtn, false)
		updateTicker()
	}
}

async function cancelRecording() {
	const recording = state.recording
	if (!recording || recording.stopping) return

	const ok = await confirmDialog({
		title: '放弃这次录制？',
		body: `已经录到的 ${recording.steps.length} 步会被丢掉，不会保存成流程。`,
		confirmText: '放弃录制',
	})
	if (!ok) return

	try {
		await api('/api/record/cancel', {
			method: 'POST',
			body: { sessionId: recording.sessionId },
		})
		state.recording = null
		toast('已放弃这次录制', 'info')
		await loadFlows({ silent: true })
		renderAll()
		updateTicker()
	} catch (err) {
		showErrorBanner(`放弃录制失败：${err.message}`, () => cancelRecording())
	}
}

async function pollRecord() {
	const recording = state.recording
	if (!recording || recording.stopping || state.busy.record) return
	const sessionId = recording.sessionId
	state.busy.record = true

	try {
		const data = await api(`/api/record/status?sessionId=${encodeURIComponent(sessionId)}`)
		if (!state.recording || state.recording.sessionId !== sessionId) return

		state.recording.elapsedMs = Number(data.elapsedMs) || 0
		state.recording.steps = Array.isArray(data.steps) ? data.steps : []

		if (data.recording === false) {
			state.recording = null
			toast('录制已经结束，流程可能已经保存，请刷新左侧列表查看', 'info')
			await loadFlows({ silent: true })
		}
	} catch (err) {
		if (!state.recording || state.recording.sessionId !== sessionId) return
		const message = `读取录制进度失败：${err.message}`
		if (!state.recording.pollErrorShown) {
			state.recording.pollErrorShown = true
			showErrorBanner(message, () => pollRecord())
		}
	} finally {
		state.busy.record = false
		renderAll()
		updateTicker()
	}
}

/* -------------------------------- 回放 ---------------------------------- */

function missingVariables() {
	return variableDefs().filter((variable) => {
		if (!variable || !variable.name) return false
		const defaultValue = typeof variable.defaultValue === 'string' ? variable.defaultValue : ''
		if (defaultValue) return false
		const value = state.variables[variable.name]
		return !(typeof value === 'string' && value.trim() !== '')
	})
}

function collectVariables() {
	const out = {}
	for (const variable of variableDefs()) {
		if (!variable || !variable.name) continue
		const value = state.variables[variable.name]
		if (typeof value === 'string' && value !== '') out[variable.name] = value
	}
	return out
}

function showVarsError(message, missingNames) {
	const host = $('vars-host')
	if (!host) return
	let node = host.querySelector('.vars-hint.is-error')
	if (!node) {
		node = document.createElement('p')
		node.className = 'vars-hint is-error'
		host.appendChild(node)
	}
	node.textContent = message
	host.querySelectorAll('input[data-var]').forEach((input) => {
		const name = input.getAttribute('data-var') || ''
		input.classList.toggle('is-invalid', missingNames.includes(name))
	})
}

function clearVarsError() {
	const host = $('vars-host')
	if (!host) return
	const node = host.querySelector('.vars-hint.is-error')
	if (node) node.remove()
	host.querySelectorAll('input[data-var].is-invalid').forEach((input) => input.classList.remove('is-invalid'))
}

async function startPlay(kind) {
	if (!state.detail || state.recording) return

	const missing = missingVariables()
	if (missing.length) {
		const names = missing.map((variable) => variable.name)
		showVarsError(`请先填写运行参数：${names.join('、')}`, names)
		toast(`请先填写运行参数：${names.join('、')}`, 'error')
		return
	}
	clearVarsError()

	const runsSelect = $('runs-select')
	const headedCheck = $('headed-check')
	const wantedRuns = kind === 'selfcheck' ? 1 : Number(runsSelect && runsSelect.value) || 1
	const headed = kind === 'selfcheck' ? false : Boolean(headedCheck && headedCheck.checked)

	state.run = { kind, runId: null, data: null, error: '', status: 'starting' }
	setBanner(null)
	renderAll()
	updateTicker()

	try {
		const result = await api('/api/play', {
			method: 'POST',
			body: {
				file: state.selectedFile,
				runs: wantedRuns,
				variables: collectVariables(),
				headed,
			},
		})
		if (!result || !result.runId) throw new Error('后端没有返回回放编号')
		if (!state.run || state.run.kind !== kind) return
		state.run.runId = String(result.runId)
		state.run.status = 'running'
		toast(kind === 'selfcheck' ? '自检已开始，跑完会显示结果' : '回放已开始，请留意浏览器窗口', 'info')
	} catch (err) {
		if (state.run) {
			state.run.error = err.message
			state.run.status = 'done'
		}
	}

	renderAll()
	updateTicker()
}

async function pollRun() {
	const run = state.run
	if (!run || !run.runId || state.busy.run) return
	const runId = run.runId
	state.busy.run = true

	try {
		const data = await api(`/api/runs/${encodeURIComponent(runId)}`)
		if (!state.run || state.run.runId !== runId) return
		state.run.data = data
		state.run.error = ''
		state.run.status = data.status === 'running' ? 'running' : 'done'
		if (state.run.status === 'done') notifyRunFinished()
	} catch (err) {
		if (!state.run || state.run.runId !== runId) return
		state.run.error = err.message
		state.run.status = 'done'
	} finally {
		state.busy.run = false
		renderAll()
		updateTicker()
	}
}

function notifyRunFinished() {
	const run = state.run
	if (!run || !run.data) return
	const key = run.runId
	if (state.lastRunToastKey === key) return
	state.lastRunToastKey = key

	const kindText = run.kind === 'selfcheck' ? '自检' : '回放'
	const data = run.data
	if (data.status === 'error') {
		toast(`${kindText}出错：${data.message || '原因见下方的步骤提示'}`, 'error')
		return
	}
	const runs = Array.isArray(data.runs) ? data.runs : []
	let failCount = 0
	let allOk = runs.length > 0
	for (const oneRun of runs) {
		const steps = Array.isArray(oneRun.steps) ? oneRun.steps : []
		failCount += steps.filter((step) => step.status === 'fail').length
		if (!oneRun.ok) allOk = false
	}
	if (runs.length === 0) {
		toast(`${kindText}结束了，但没有拿到结果`, 'info')
	} else if (allOk) {
		toast(`${kindText}完成：${runs.length} 轮全部通过`, 'success')
	} else {
		toast(`${kindText}完成：有 ${failCount} 步没通过，下面能看原因`, 'error')
	}
}

async function stopRun() {
	const run = state.run
	if (!run || !run.runId) return
	try {
		await api(`/api/runs/${encodeURIComponent(run.runId)}/stop`, { method: 'POST' })
		toast('已发送停止请求', 'info')
	} catch (err) {
		toast(`停止失败：${err.message}（后端可能还没实现这个接口）`, 'error')
	}
}

/* --------------------------- 重命名 / 删除步骤 --------------------------- */

function beginRename() {
	if (!state.detail) return
	state.editingTitle = true
	renderDetailHeader()
}

function cancelRename() {
	state.editingTitle = false
	renderDetailHeader()
}

async function saveRename() {
	if (!state.selectedFile) return
	const input = $('rename-input')
	const title = input ? input.value.trim() : ''
	if (!title) {
		toast('名字不能为空', 'error')
		if (input) input.focus()
		return
	}

	try {
		await api(`/api/flows/${encodeURIComponent(state.selectedFile)}/rename`, {
			method: 'POST',
			body: { title },
		})
		if (state.detail) state.detail.flow = Object.assign({}, state.detail.flow, { title })
		state.editingTitle = false
		toast('名字已改好', 'success')
		await loadFlows({ silent: true })
		renderAll()
	} catch (err) {
		showErrorBanner(`改名失败：${err.message}`, () => saveRename())
	}
}

async function deleteStep(stepId) {
	if (!state.selectedFile || !state.detail || !stepId) return
	const steps = Array.isArray(state.detail.steps) ? state.detail.steps : []
	const index = steps.findIndex((step) => step && step.id === stepId)
	const step = index >= 0 ? steps[index] : null
	const no = step ? stepNumber(step, index, steps) : ''
	const title = step && step.title ? step.title : stepId

	const ok = await confirmDialog({
		title: '删除这一步？',
		body: `第 ${no} 步「${title}」会从流程里删掉，以后回放就不再执行它。这个操作不能撤销。`,
		confirmText: '删除',
	})
	if (!ok) return

	try {
		await api(
			`/api/flows/${encodeURIComponent(state.selectedFile)}/steps/${encodeURIComponent(stepId)}/delete`,
			{ method: 'POST' }
		)
		toast('已删除这一步', 'success')
		await reloadDetail()
		await loadFlows({ silent: true })
	} catch (err) {
		showErrorBanner(`删除失败：${err.message}`, () => deleteStep(stepId))
	}
}

/* -------------------------------- 轮询 ---------------------------------- */

function updateTicker() {
	const needed =
		Boolean(state.recording) ||
		Boolean(state.run && state.run.runId && state.run.status === 'running')

	if (needed && !state.ticker) state.ticker = window.setInterval(tick, POLL_MS)
	if (!needed && state.ticker) {
		window.clearInterval(state.ticker)
		state.ticker = null
	}
}

function tick() {
	try {
		if (state.recording && !state.recording.stopping) void pollRecord()
		if (state.run && state.run.runId && state.run.status === 'running') void pollRun()
	} catch (err) {
		showErrorBanner(`刷新进度时出错：${err && err.message ? err.message : err}`)
	}
}

/* ------------------------------- 事件绑定 ------------------------------- */

function handleClick(event) {
	const target = event.target instanceof Element ? event.target.closest('[data-action]') : null
	if (!target) return
	const action = target.getAttribute('data-action')

	switch (action) {
		case 'select-flow': {
			const file = target.getAttribute('data-file') || ''
			if (state.recording) {
				toast('正在录制，先停止并保存再切换流程', 'info')
				return
			}
			if (file && file !== state.selectedFile) void selectFlow(file)
			return
		}
		case 'begin-rename':
			beginRename()
			return
		case 'save-rename':
			void saveRename()
			return
		case 'cancel-rename':
			cancelRename()
			return
		case 'reload-detail':
			void reloadDetail()
			return
		case 'delete-step':
			void deleteStep(target.getAttribute('data-step-id') || '')
			return
		case 'play':
			void startPlay('replay')
			return
		case 'selfcheck':
			void startPlay('selfcheck')
			return
		case 'stop-run':
			void stopRun()
			return
		case 'toggle-secret': {
			const name = target.getAttribute('data-target') || ''
			const host = $('vars-host')
			const input = host
				? host.querySelector(`input[data-var="${name.replace(/"/g, '\\"')}"]`)
				: null
			if (!input) return
			const showing = input.getAttribute('type') === 'text'
			input.setAttribute('type', showing ? 'password' : 'text')
			target.textContent = showing ? '显示' : '隐藏'
			return
		}
		case 'zoom':
			openZoom(target.getAttribute('data-src') || '', target.getAttribute('data-name') || '')
			return
		case 'retry-flows':
			void loadFlows()
			return
		case 'banner-action': {
			const banner = state.banner
			if (banner && typeof banner.onAction === 'function') {
				setBanner(null)
				banner.onAction()
			}
			return
		}
		case 'banner-close':
			setBanner(null)
			return
		default:
			return
	}
}

function handleInput(event) {
	const target = event.target
	if (!(target instanceof HTMLInputElement)) return
	const name = target.getAttribute('data-var')
	if (name === null) return
	state.variables[name] = target.value
	if (target.classList.contains('is-invalid') && target.value.trim() !== '') {
		target.classList.remove('is-invalid')
	}
}

function handleKeydown(event) {
	const target = event.target
	if (target instanceof HTMLElement && target.id === 'rename-input') {
		if (event.key === 'Enter') {
			event.preventDefault()
			void saveRename()
		} else if (event.key === 'Escape') {
			event.preventDefault()
			cancelRename()
		}
	}
}

function bindEvents() {
	if (dom.recordForm) {
		dom.recordForm.addEventListener('submit', (event) => {
			event.preventDefault()
			void startRecording()
		})
	}
	if (dom.stopBtn) dom.stopBtn.addEventListener('click', () => void stopRecording())
	if (dom.cancelBtn) dom.cancelBtn.addEventListener('click', () => void cancelRecording())
	if (dom.refreshBtn) {
		dom.refreshBtn.addEventListener('click', () => {
			void loadFlows()
			if (state.selectedFile) void reloadDetail()
		})
	}
	if (dom.urlInput) {
		dom.urlInput.addEventListener('input', () => {
			if (dom.urlInput.value.trim()) clearUrlError()
		})
	}

	document.addEventListener('click', handleClick)
	document.addEventListener('input', handleInput)
	document.addEventListener('keydown', handleKeydown)

	// 截图加载失败时不刷 console，直接隐藏坏图（后端可能还没产出 artifact）
	document.addEventListener(
		'error',
		(event) => {
			const target = event.target
			if (!(target instanceof HTMLImageElement)) return
			const button = target.closest('.thumb-btn')
			if (button) {
				button.textContent = '无截图'
				button.classList.add('is-broken')
			} else {
				target.style.visibility = 'hidden'
			}
		},
		true
	)
}

function cacheDom() {
	dom.recordForm = $('record-form')
	dom.urlInput = $('record-url')
	dom.titleInput = $('record-title')
	dom.recordHint = $('record-hint')
	dom.startBtn = $('btn-start')
	dom.stopBtn = $('btn-stop')
	dom.cancelBtn = $('btn-cancel')
	dom.recordClock = $('record-clock')
	dom.recordClockText = $('record-clock-text')
	dom.refreshBtn = $('btn-refresh')
	dom.bannerHost = $('banner-host')
	dom.flowsPane = document.querySelector('.flows-pane')
	dom.flowsMeta = $('flows-meta')
	dom.flowsHost = $('flows-host')
	dom.detailHeader = $('detail-header')
	dom.timeline = $('timeline')
	dom.bottomPanel = $('bottom-panel')
	dom.toastHost = $('toast-host')
	dom.modalRoot = $('modal-root')
}

/* --------------------------------- 启动 --------------------------------- */

async function init() {
	cacheDom()
	bindEvents()
	renderAll()

	await Promise.all([loadConfig(), loadFlows()])

	let deepLink = ''
	try {
		deepLink = new URLSearchParams(window.location.search).get('file') || ''
	} catch {
		deepLink = ''
	}
	if (deepLink) await selectFlow(deepLink)

	renderAll()
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => void init())
} else {
	void init()
}
