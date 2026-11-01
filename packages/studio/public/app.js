/* global window, document, fetch, URL, URLSearchParams, Element, HTMLElement, HTMLInputElement, HTMLImageElement, HTMLSelectElement, HTMLTextAreaElement */
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

/** 参数化建议（契约见 docs/parameterization.md §7） */
const CONFIDENCE_TEXT = { high: '高', medium: '中', weak: '弱' }

/** 变量类型展示（schema 允许 string/text/email/date/number/secret/file） */
const VAR_TYPE_TEXT = {
	string: '文本',
	text: '多行文本',
	email: '邮箱',
	date: '日期',
	number: '数字',
	secret: '保密',
	file: '文件',
}

/** 可被接受的变量类型（与 @rr/suggest 的 SuggestVariableType 对齐，另加 text） */
const SUGGEST_TYPE_OPTIONS = ['string', 'text', 'email', 'date', 'number']

const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const IGNORED_STORAGE_PREFIX = 'rr-studio-ignored-suggestions'

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
	suggestions: null, // FlowSuggestions | null
	suggestionsPhase: 'idle', // idle | loading | ready | error
	suggestionsError: '',
	ignoredSuggestions: new Set(),
	showIgnoredSuggestions: false,
	profiles: [], // ProfileMeta[]
	profilesPhase: 'idle', // idle | loading | ready | unsupported | error
	profilesError: '',
	login: null, // { sessionId, url, startedAt, elapsedMs, busy }
	rerecord: null, // { file, stepId, stepNo, title, sessionId, startUrl, phase }
	batch: null, // CSV 批量执行：见 createBatchState()
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
		const error = new Error(message)
		error.status = response.status
		throw error
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
	const busy = Boolean(banner.busy)
	const actions = []
	if (Array.isArray(banner.actions)) {
		for (const item of banner.actions) {
			if (!item || !item.action || !item.label) continue
			const variant = item.variant === 'primary' ? 'btn-primary' : 'btn-ghost'
			actions.push(
				`<button type="button" class="btn btn-small ${variant}" data-action="${esc(item.action)}" ${busy ? 'disabled' : ''}>${esc(item.label)}</button>`
			)
		}
	} else if (banner.actionLabel) {
		actions.push(
			`<button type="button" class="btn btn-small btn-ghost" data-action="banner-action" ${busy ? 'disabled' : ''}>${esc(banner.actionLabel)}</button>`
		)
	}
	const timer = banner.timer
		? `<span class="banner-timer" id="banner-timer">${esc(banner.timerText || '')}</span>`
		: ''
	const dismissible = banner.dismissible !== false
	setHtml(
		host,
		`<div class="banner banner-${type}" role="alert">
			<span class="banner-msg">${esc(banner.message)}</span>
			${timer}
			${actions.length ? `<span class="banner-actions">${actions.join('')}</span>` : ''}
			${dismissible ? '<button type="button" class="btn-icon" data-action="banner-close" aria-label="关闭提示">✕</button>' : ''}
		</div>`
	)
}

function setBannerBusy(busy) {
	if (!state.banner) return
	state.banner.busy = Boolean(busy)
	renderBanner()
}

/** 只改 banner 里的计时文案，避免每 2 秒重排整个提示条 */
function updateBannerTimer(text) {
	const node = $('banner-timer')
	if (node) node.textContent = String(text || '')
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
	const previousFocus = document.activeElement
	// 用独立遮罩叠在最上层：批量运行弹窗里看截图时不会把弹窗冲掉
	const overlay = document.createElement('div')
	overlay.className = 'modal-overlay modal-zoom-overlay'
	overlay.setAttribute('data-modal', 'zoom')
	overlay.innerHTML = `<div class="modal-card modal-zoom" role="dialog" aria-modal="true" aria-label="步骤截图">
			<div class="zoom-bar">
				<span class="zoom-name">${esc(name || '步骤截图')}</span>
				<button type="button" class="btn btn-small btn-ghost" data-modal-action="close">关闭</button>
			</div>
			<img src="${esc(url)}" alt="${esc(name || '步骤截图')}" />
		</div>`
	document.body.appendChild(overlay)

	const onKey = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			close()
		}
	}
	const close = () => {
		document.removeEventListener('keydown', onKey)
		overlay.remove()
		if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
	}
	document.addEventListener('keydown', onKey)
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) close()
	})
	const closeButton = overlay.querySelector('[data-modal-action="close"]')
	if (closeButton) closeButton.addEventListener('click', close)
}

/* --------------------------- 参数化建议交互 ------------------------------ */

/** 通用弹窗外壳：统一 Esc / 点遮罩关闭 / 焦点归还 */
function createModal(options) {
	const cfg = options || {}
	const root = dom.modalRoot
	const previousFocus = document.activeElement
	root.innerHTML = `<div class="modal-overlay" data-modal="${esc(cfg.name || 'dialog')}">
		<div class="modal-card ${cfg.dialogClass || ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
			<h3 id="modal-title">${esc(cfg.title || '')}</h3>
			${cfg.bodyHtml || ''}
			<div class="modal-actions">${cfg.actionsHtml || ''}</div>
		</div>
	</div>`

	const overlay = root.querySelector('.modal-overlay')
	let closed = false
	const onKey = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			close(null)
		}
	}
	const close = (value) => {
		if (closed) return
		closed = true
		document.removeEventListener('keydown', onKey)
		root.innerHTML = ''
		if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
		if (typeof cfg.onClose === 'function') cfg.onClose(value)
	}
	document.addEventListener('keydown', onKey)
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) close(null)
	})
	return { root, overlay, close }
}

/** 接受建议弹窗：变量名（实时校验/重名提示）、类型、同值批量、理由 */
function suggestionApplyDialog(suggestion, options) {
	const opts = options || {}
	const file = state.selectedFile
	if (!file || !suggestion) return Promise.resolve(null)

	const maps = stepTitleMaps()
	const groupIds =
		suggestion.group && Array.isArray(suggestion.group.stepIds) ? suggestion.group.stepIds : []
	const hasGroup = groupIds.length > 1
	const groupItems = groupIds
		.map((id) => {
			const step = maps.byId.get(id)
			const no = maps.noById.get(id)
			return `<li>第 ${esc(no || '?')} 步 ${esc(step && step.title ? step.title : '同值步骤')}</li>`
		})
		.join('')
	const typeOptions = SUGGEST_TYPE_OPTIONS.map((type) => {
		const selected = type === (suggestion.suggestedType || 'string') ? ' selected' : ''
		return `<option value="${esc(type)}"${selected}>${esc(VAR_TYPE_TEXT[type] || type)}</option>`
	}).join('')
	const reasons = Array.isArray(suggestion.reasons) ? suggestion.reasons.filter(Boolean) : []
	const reasonsHtml = reasons.length
		? `<div class="dialog-reasons"><span class="dialog-label">为什么这样建议</span><ul>${reasons
				.map((reason) => `<li>${esc(reason)}</li>`)
				.join('')}</ul></div>`
		: ''

	return new Promise((resolve) => {
		const modal = createModal({
			name: 'suggest-apply',
			dialogClass: 'modal-suggest',
			title: '参数化这一步',
			bodyHtml: `<form class="suggest-form" novalidate>
				<p class="dialog-lead">把写死的值换成运行参数，以后回放时可以填不同的值。</p>
				<div class="dialog-field">
					<label class="dialog-label" for="suggest-name-input">变量名</label>
					<input id="suggest-name-input" class="dialog-input" type="text" spellcheck="false" autocomplete="off" value="${esc(suggestion.suggestedName || '')}" />
					<p class="dialog-hint" id="suggest-name-hint"></p>
				</div>
				<div class="dialog-field">
					<label class="dialog-label" for="suggest-type-input">类型</label>
					<select id="suggest-type-input" class="dialog-input">${typeOptions}</select>
				</div>
				<div class="dialog-preview" id="suggest-preview"></div>
				${
					hasGroup
						? `<label class="dialog-check"><input type="checkbox" id="suggest-same-input" checked /> 同值一起替换（${groupIds.length} 处）</label>
							<ul class="dialog-group-list">${groupItems}</ul>`
						: ''
				}
				${reasonsHtml}
				<p class="dialog-error" id="suggest-dialog-error" hidden></p>
			</form>`,
			actionsHtml: `<button type="button" class="btn btn-ghost" data-dialog-action="cancel">取消</button>
				<button type="button" class="btn btn-primary" data-dialog-action="confirm">确认参数化</button>`,
			onClose: (value) => resolve(value || null),
		})

		const nameInput = modal.root.querySelector('#suggest-name-input')
		const typeSelect = modal.root.querySelector('#suggest-type-input')
		const sameCheckbox = modal.root.querySelector('#suggest-same-input')
		const previewNode = modal.root.querySelector('#suggest-preview')
		const hintNode = modal.root.querySelector('#suggest-name-hint')
		const errorNode = modal.root.querySelector('#suggest-dialog-error')
		const confirmButton = modal.root.querySelector('[data-dialog-action="confirm"]')
		const cancelButton = modal.root.querySelector('[data-dialog-action="cancel"]')

		const showError = (message) => {
			errorNode.textContent = message
			errorNode.hidden = !message
		}
		const updatePreview = () => {
			const name = nameInput.value.trim() || '变量名'
			previewNode.innerHTML = `当前值 <code>${esc(
				truncateText(String(suggestion.currentValue || ''), 40)
			)}</code> → <code>{{${esc(name)}}}</code>`
		}
		const validate = () => {
			const value = nameInput.value.trim()
			let hard = ''
			let soft = ''
			if (!value) hard = '变量名不能为空'
			else if (!VARIABLE_NAME_RE.test(value)) hard = '只能用英文字母、数字和下划线，且不能以数字开头'
			else {
				const existing = variableDefs()
					.map((item) => item && item.name)
					.filter(Boolean)
				if (existing.includes(value)) soft = `已经有同名参数「${value}」了，确认后会复用它`
				const other = activeSuggestions().find(
					(item) => item.stepId !== suggestion.stepId && item.suggestedName === value
				)
				if (!soft && other) soft = `另一条建议也叫「${value}」，建议换个名字`
			}
			hintNode.textContent = hard || soft
			hintNode.classList.toggle('is-error', Boolean(hard))
			hintNode.classList.toggle('is-warning', !hard && Boolean(soft))
			confirmButton.disabled = Boolean(hard)
			return hard
		}
		const submit = async () => {
			if (validate()) {
				nameInput.focus()
				return
			}
			const name = nameInput.value.trim()
			confirmButton.disabled = true
			confirmButton.innerHTML = '<span class="spinner"></span>处理中…'
			showError('')
			try {
				const res = await api(
					`/api/flows/${encodeURIComponent(file)}/apply-suggestion`,
					{
						method: 'POST',
						body: {
							stepId: suggestion.stepId,
							name,
							type: typeSelect.value,
							applySameValue: hasGroup ? Boolean(sameCheckbox && sameCheckbox.checked) : false,
						},
					}
				)
				modal.close({ name, res })
			} catch (err) {
				confirmButton.textContent = '确认参数化'
				confirmButton.disabled = false
				showError(err.message)
			}
		}

		nameInput.addEventListener('input', () => {
			validate()
			updatePreview()
		})
		nameInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault()
				void submit()
			}
		})
		cancelButton.addEventListener('click', () => modal.close(null))
		confirmButton.addEventListener('click', () => void submit())

		validate()
		updatePreview()
		if (opts.focus === 'name') {
			nameInput.focus()
			nameInput.select()
		} else {
			confirmButton.focus()
		}
	})
}

async function openSuggestionDialog(stepId, mode) {
	if (!state.detail || state.recording) return
	const id = String(stepId || '')
	const suggestion = allSuggestions().find((item) => item.stepId === id)
	if (!suggestion) {
		toast('这条建议已经不存在了，正在刷新建议', 'info')
		await loadSuggestions(state.selectedFile)
		return
	}
	const result = await suggestionApplyDialog(suggestion, {
		focus: mode === 'modify' ? 'name' : 'confirm',
	})
	if (!result) return
	toast(`已参数化：写死的值换成了 {{${result.name}}}`, 'success')
	await applyFlowResult(result.res)
}

function mergeVariables(current, next) {
	const out = Object.create(null)
	for (const name of Object.keys(next || {})) {
		out[name] =
			current && Object.prototype.hasOwnProperty.call(current, name) ? current[name] : next[name]
	}
	return out
}

function uniqueVariableName(base, taken) {
	let name = String(base || '').trim()
	if (!VARIABLE_NAME_RE.test(name)) name = 'field'
	if (!taken.has(name)) return name
	let index = 2
	while (taken.has(`${name}_${index}`)) index += 1
	return `${name}_${index}`
}

/** 应用接口返回 {ok, flow, steps, suggestions}；字段缺失时退回重新拉取 */
async function applyFlowResult(res) {
	const file = state.selectedFile
	if (!file) return
	const oldVersion = suggestionVersion()
	const payload = res && typeof res === 'object' ? res : null

	if (payload && payload.flow && Array.isArray(payload.steps) && payload.suggestions) {
		state.detail = { flow: payload.flow, steps: payload.steps }
		state.detailPhase = 'ready'
		state.detailError = ''
		state.suggestions = normalizeSuggestions(payload.suggestions)
		state.suggestionsPhase = 'ready'
		state.suggestionsError = ''
		const newVersion = suggestionVersion()
		if (oldVersion !== newVersion) persistIgnoredForVersion(newVersion)
		state.variables = mergeVariables(state.variables, buildVariables(payload.flow))
		state.bottomKey = null
		state.varsBuiltKey = null
		renderAll()
		void loadFlows({ silent: true })
		return
	}
	await reloadDetail()
	void loadFlows({ silent: true })
}

async function acceptAllSuggestions() {
	if (!state.detail || state.recording || !state.selectedFile) return
	const running = Boolean(
		state.run && (state.run.status === 'starting' || state.run.status === 'running')
	)
	if (running) {
		toast('回放进行中，等它跑完再接受建议', 'info')
		return
	}
	const active = activeSuggestions()
	if (!active.length) return

	const taken = new Set(variableDefs().map((item) => item && item.name).filter(Boolean))
	const seen = new Set()
	const batch = []
	for (const suggestion of active) {
		if (seen.has(suggestion.stepId)) continue
		const groupIds =
			suggestion.group && Array.isArray(suggestion.group.stepIds) ? suggestion.group.stepIds : []
		const applySameValue = groupIds.length > 1
		const name = uniqueVariableName(suggestion.suggestedName, taken)
		taken.add(name)
		batch.push({
			stepId: suggestion.stepId,
			name,
			type: suggestion.suggestedType || 'string',
			applySameValue,
		})
		if (applySameValue) for (const id of groupIds) seen.add(id)
		else seen.add(suggestion.stepId)
	}
	if (!batch.length) return

	const ok = await confirmDialog({
		title: `全部接受 ${batch.length} 条建议？`,
		body: `会新增这些运行参数：${batch.map((item) => item.name).join('、')}。流程里对应的写死值会变成 {{变量名}}，同值的步骤会一起替换。`,
		confirmText: '全部接受',
		danger: false,
	})
	if (!ok) return

	try {
		const res = await api(
			`/api/flows/${encodeURIComponent(state.selectedFile)}/apply-suggestions`,
			{ method: 'POST', body: { apply: batch } }
		)
		toast(`已参数化 ${batch.length} 条建议`, 'success')
		await applyFlowResult(res)
	} catch (err) {
		// 后端还没实现批量接口时，退化为逐条应用（契约允许"依次 POST"）
		if (err && (err.status === 404 || err.status === 405)) {
			await applyBatchSequentially(batch)
			return
		}
		showErrorBanner(`批量参数化失败：${err.message}`)
	}
}

async function applyBatchSequentially(batch) {
	let done = 0
	for (const item of batch) {
		try {
			await api(`/api/flows/${encodeURIComponent(state.selectedFile)}/apply-suggestion`, {
				method: 'POST',
				body: item,
			})
			done += 1
		} catch (err) {
			toast(`批量参数化中断：已完成 ${done} 条（${err.message}）`, 'error')
			await reloadDetail()
			return
		}
	}
	toast(`已参数化 ${done} 条建议`, 'success')
	await reloadDetail()
	void loadFlows({ silent: true })
}

/** 单输入框弹窗（变量重命名用），自带校验与提交错误回显 */
function textPromptDialog(options) {
	const cfg = options || {}
	return new Promise((resolve) => {
		const modal = createModal({
			name: 'text-prompt',
			dialogClass: 'modal-prompt',
			title: cfg.title || '请填写',
			bodyHtml: `<form class="suggest-form" novalidate>
				${cfg.lead ? `<p class="dialog-lead">${esc(cfg.lead)}</p>` : ''}
				<div class="dialog-field">
					<label class="dialog-label" for="prompt-input">${esc(cfg.label || '')}</label>
					<input id="prompt-input" class="dialog-input" type="text" spellcheck="false" autocomplete="off" value="${esc(cfg.value || '')}" />
					<p class="dialog-hint" id="prompt-hint">${esc(cfg.hint || '')}</p>
				</div>
				<p class="dialog-error" id="prompt-error" hidden></p>
			</form>`,
			actionsHtml: `<button type="button" class="btn btn-ghost" data-dialog-action="cancel">取消</button>
				<button type="button" class="btn btn-primary" data-dialog-action="confirm">${esc(cfg.confirmText || '确定')}</button>`,
			onClose: (value) => resolve(value || null),
		})

		const input = modal.root.querySelector('#prompt-input')
		const hintNode = modal.root.querySelector('#prompt-hint')
		const errorNode = modal.root.querySelector('#prompt-error')
		const confirmButton = modal.root.querySelector('[data-dialog-action="confirm"]')
		const cancelButton = modal.root.querySelector('[data-dialog-action="cancel"]')

		const showError = (message) => {
			errorNode.textContent = message
			errorNode.hidden = !message
		}
		const validate = () => {
			const value = input.value.trim()
			const message = typeof cfg.validate === 'function' ? cfg.validate(value) : ''
			hintNode.textContent = message || cfg.hint || ''
			hintNode.classList.toggle('is-error', Boolean(message))
			confirmButton.disabled = Boolean(message)
			return message ? null : value
		}
		const submit = async () => {
			const value = validate()
			if (!value) {
				input.focus()
				return
			}
			confirmButton.disabled = true
			confirmButton.innerHTML = '<span class="spinner"></span>处理中…'
			showError('')
			try {
				await cfg.submit(value)
				modal.close(value)
			} catch (err) {
				confirmButton.textContent = cfg.confirmText || '确定'
				confirmButton.disabled = false
				showError(err.message)
			}
		}

		input.addEventListener('input', () => {
			validate()
			showError('')
		})
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault()
				void submit()
			}
		})
		cancelButton.addEventListener('click', () => modal.close(null))
		confirmButton.addEventListener('click', () => void submit())

		validate()
		input.focus()
		input.select()
	})
}

async function renameVariable(fromName) {
	if (!fromName || !state.selectedFile || state.recording) return
	const file = state.selectedFile
	const ignoredBefore = new Set(state.ignoredSuggestions)
	const result = await textPromptDialog({
		title: '重命名运行参数',
		lead: `把「${fromName}」换成更好懂的名字，流程里用到它的地方会自动跟着改。`,
		label: '新的参数名',
		value: fromName,
		hint: '只能用英文字母、数字和下划线，且不能以数字开头',
		confirmText: '重命名',
		validate: (value) => {
			if (!value) return '参数名不能为空'
			if (!VARIABLE_NAME_RE.test(value)) return '只能用英文字母、数字和下划线，且不能以数字开头'
			if (value === fromName) return '和原来的名字一样'
			if (variableDefs().some((item) => item && item.name === value)) {
				return `已经有同名参数「${value}」了`
			}
			return ''
		},
		submit: async (value) => {
			await api(`/api/flows/${encodeURIComponent(file)}/variables/rename`, {
				method: 'POST',
				body: { from: fromName, to: value },
			})
		},
	})
	if (!result) return

	if (Object.prototype.hasOwnProperty.call(state.variables, fromName) || result in state.variables) {
		state.variables[result] = state.variables[fromName]
		delete state.variables[fromName]
	}
	state.bottomKey = null
	state.varsBuiltKey = null
	toast(`已把「${fromName}」改名为「${result}」`, 'success')
	await reloadDetail()
	// 重命名会让 version+1，忽略状态的 key 跟着变，这里把已忽略项带到新版本
	if (ignoredBefore.size) {
		state.ignoredSuggestions = ignoredBefore
		persistIgnoredForVersion(suggestionVersion())
		renderAll()
	}
	void loadFlows({ silent: true })
}

/* --------------------------- 登录态（profiles） -------------------------- */

let loginPollTimer = null

function flowStartUrl() {
	const flow = state.detail && state.detail.flow
	const url = flow && flow.meta && flow.meta.env && flow.meta.env.startUrl
	return typeof url === 'string' ? url : ''
}

function originOfUrl(raw) {
	if (typeof raw !== 'string' || !raw) return ''
	try {
		return new URL(raw).origin
	} catch {
		return ''
	}
}

function flowOrigin() {
	return originOfUrl(flowStartUrl())
}

function profileForCurrentFlow() {
	const origin = flowOrigin()
	if (!origin) return null
	const list = Array.isArray(state.profiles) ? state.profiles : []
	return list.find((item) => item && item.origin === origin) || null
}

function formatTimeAgo(iso) {
	if (!iso) return ''
	const time = new Date(iso).getTime()
	if (!Number.isFinite(time)) return ''
	const diff = Date.now() - time
	if (diff < 0) return '刚刚'
	const minute = 60_000
	if (diff < minute) return '刚刚'
	if (diff < 60 * minute) return `${Math.max(1, Math.round(diff / minute))} 分钟前`
	if (diff < 24 * 60 * minute) return `${Math.round(diff / (60 * minute))} 小时前`
	if (diff < 30 * 24 * 60 * minute) return `${Math.round(diff / (24 * 60 * minute))} 天前`
	return fmtDate(iso)
}

function isRunActive() {
	return Boolean(state.run && (state.run.status === 'starting' || state.run.status === 'running'))
}

/** 登录 / 单步重录 / CSV 批量执行这类"进行中的长操作"，互相禁止并发 */
function hasActiveSession() {
	return Boolean(state.login) || Boolean(state.rerecord) || isBatchBusy()
}

function canManageProfile() {
	return Boolean(state.detail) && !state.recording && !isRunActive() && !hasActiveSession()
}

async function loadProfiles(options) {
	const opts = options || {}
	if (!opts.silent) {
		state.profilesPhase = 'loading'
		renderDetailHeader()
	}
	try {
		const data = await api('/api/profiles')
		state.profiles = Array.isArray(data && data.profiles)
			? data.profiles.filter((item) => item && item.origin)
			: []
		state.profilesPhase = 'ready'
		state.profilesError = ''
	} catch (err) {
		// 契约 A.3：接口 404/失败时降级为不显示登录态，不阻塞主流程
		state.profiles = []
		state.profilesPhase = err && err.status === 404 ? 'unsupported' : 'error'
		state.profilesError = err && err.message ? err.message : '读取登录态失败'
	}
	renderDetailHeader()
}

function ensureProfiles() {
	if (state.profilesPhase === 'idle' || state.profilesPhase === 'error') void loadProfiles({ silent: true })
}

/** 某个站点 origin 的登录态 chip + 「更新登录态」「清除」按钮（接口不可用时不显示） */
function loginStateHtmlFor(origin, options) {
	const opts = options || {}
	if (state.profilesPhase !== 'ready' || !origin) return ''
	if (state.login) {
		return '<span class="login-state"><span class="chip chip-login-pending">🔐 登录窗口中…</span></span>'
	}
	const list = Array.isArray(state.profiles) ? state.profiles : []
	const profile = list.find((item) => item && item.origin === origin) || null
	const busy =
		opts.disabled !== undefined
			? Boolean(opts.disabled)
			: state.recording || isRunActive() || Boolean(state.rerecord)
	const updateButton = `<button type="button" class="btn btn-tiny btn-ghost" data-action="login-update" ${busy ? 'disabled' : ''} title="打开浏览器登录一次，保存登录态供回放使用">更新登录态</button>`
	if (profile) {
		const ago = formatTimeAgo(profile.savedAt)
		return `<span class="login-state">
			<span class="chip chip-login-saved" title="站点 ${esc(profile.origin)}；保存于 ${esc(ago)}">🔐 已保存登录态（更新于 ${esc(ago)}）</span>
			${updateButton}
			<button type="button" class="btn btn-tiny btn-ghost" data-action="login-clear" ${busy ? 'disabled' : ''}>清除</button>
		</span>`
	}
	return `<span class="login-state"><span class="chip chip-login-none">🔓 未保存登录态</span>${updateButton}</span>`
}

/** 流程头部（非录制态）用：按流程起始网址的 origin 匹配 */
function loginStateHtml() {
	if (!state.detail) return ''
	return loginStateHtmlFor(flowOrigin())
}

async function startLoginUpdate() {
	if (!state.detail) return
	if (!canManageProfile()) {
		toast('回放或重录进行中，等结束再更新登录态', 'info')
		return
	}
	const origin = flowOrigin()
	if (!origin) {
		toast('这个流程没有记录起始网址，无法更新登录态', 'error')
		return
	}
	state.login = { sessionId: '', url: flowStartUrl(), startedAt: Date.now(), elapsedMs: 0 }
	setBanner({ type: 'info', message: '正在打开浏览器…', dismissible: false })
	renderAll()

	try {
		const res = await api('/api/profiles/login/start', {
			method: 'POST',
			body: { url: flowStartUrl() },
		})
		if (!res || !res.sessionId) throw new Error('后端没有返回登录会话号')
		state.login = {
			sessionId: String(res.sessionId),
			url: flowStartUrl(),
			startedAt: Date.now(),
			elapsedMs: 0,
		}
		setBanner({
			type: 'info',
			message: `请在新打开的浏览器里登录 ${origin}，完成后点「完成并保存」`,
			actions: [
				{ action: 'login-stop', label: '完成并保存', variant: 'primary' },
				{ action: 'login-cancel', label: '取消' },
			],
			dismissible: false,
			timer: true,
			timerText: '已等待 00:00',
		})
		startLoginPoller()
		toast('已打开登录窗口，请在新窗口里完成登录', 'success')
	} catch (err) {
		state.login = null
		showErrorBanner(`打开登录窗口失败：${err.message}`, () => startLoginUpdate())
	}
	renderAll()
}

async function stopLogin() {
	const login = state.login
	if (!login || !login.sessionId || login.busy) return
	login.busy = true
	setBannerBusy(true)
	try {
		await api('/api/profiles/login/stop', {
			method: 'POST',
			body: { sessionId: login.sessionId },
		})
		state.login = null
		stopLoginPoller()
		setBanner(null)
		await loadProfiles({ silent: true })
		toast('登录态已保存，以后回放会自动带上', 'success')
	} catch (err) {
		login.busy = false
		setBanner({
			type: 'error',
			message: `保存登录态失败：${err.message}`,
			actions: [
				{ action: 'login-stop', label: '重试保存', variant: 'primary' },
				{ action: 'login-cancel', label: '取消' },
			],
			dismissible: false,
			timer: true,
			timerText: `已等待 ${fmtClock(login.elapsedMs)}`,
		})
	}
	renderAll()
}

async function cancelLogin() {
	const login = state.login
	if (!login) return
	if (login.sessionId) {
		try {
			await api('/api/profiles/login/cancel', {
				method: 'POST',
				body: { sessionId: login.sessionId },
			})
		} catch {
			/* 浏览器可能已经被用户关掉，忽略 */
		}
	}
	state.login = null
	stopLoginPoller()
	setBanner(null)
	toast('已取消更新登录态', 'info')
	renderAll()
}

async function clearLoginProfile() {
	if (!canManageProfile()) {
		toast('回放或重录进行中，等结束再操作', 'info')
		return
	}
	const profile = profileForCurrentFlow()
	if (!profile) return
	const ok = await confirmDialog({
		title: '清除登录态？',
		body: `清除后，回放「${profile.origin}」时需要重新登录。登录态只保存在这台电脑上，不会影响其它站点。`,
		confirmText: '清除登录态',
	})
	if (!ok) return
	try {
		await api(`/api/profiles/${encodeURIComponent(profile.originKey)}`, { method: 'DELETE' })
		toast('登录态已清除', 'success')
		await loadProfiles({ silent: true })
	} catch (err) {
		showErrorBanner(`清除登录态失败：${err.message}`)
	}
	renderAll()
}

function startLoginPoller() {
	stopLoginPoller()
	loginPollTimer = window.setInterval(() => void pollLoginStatus(), 2000)
}

function stopLoginPoller() {
	if (loginPollTimer) {
		window.clearInterval(loginPollTimer)
		loginPollTimer = null
	}
}

/** 轮询登录会话：更新已等待时间；后端超时自动关闭时收起 banner（老后端无此接口则静默） */
async function pollLoginStatus() {
	const login = state.login
	if (!login || !login.sessionId) return
	try {
		const data = await api(
			`/api/profiles/login/status?sessionId=${encodeURIComponent(login.sessionId)}`
		)
		if (!state.login || state.login.sessionId !== login.sessionId) return
		state.login.elapsedMs = Number(data && data.elapsedMs) || state.login.elapsedMs
		updateBannerTimer(`已等待 ${fmtClock(state.login.elapsedMs)}`)
		if (data && data.running === false) {
			state.login = null
			stopLoginPoller()
			setBanner(null)
			toast('登录窗口已关闭，这次登录没有保存', 'info')
			renderAll()
		}
	} catch {
		/* 状态接口不可用：不打扰用户，手动保存仍然可用 */
	}
}

/* ---------------------------- 单步重录 ---------------------------------- */

function rerecordBusy() {
	return Boolean(state.recording) || isRunActive() || hasActiveSession()
}

async function startRerecord(stepId) {
	if (!state.detail || !state.selectedFile) return
	if (rerecordBusy()) {
		toast('录制、回放或其它重录进行中，等结束再操作', 'info')
		return
	}
	const steps = Array.isArray(state.detail.steps) ? state.detail.steps : []
	const index = steps.findIndex((item) => item && item.id === stepId)
	const step = index >= 0 ? steps[index] : null
	if (!step) {
		toast('找不到这一步，刷新后再试', 'error')
		return
	}
	if (step.kind === 'group') {
		toast('分组步骤暂不支持单步重录', 'info')
		return
	}
	const no = stepNumber(step, index, steps)
	const ok = await confirmDialog({
		title: `重录第 ${no} 步？`,
		body: '会打开一个浏览器窗口，你手动走到这一步所在的页面，操作一遍；录制只在你本机进行，不会上传。录完点「停止并选择这一步」，再从候选动作里选一个替换。',
		confirmText: '开始重录',
		danger: false,
	})
	if (!ok) return

	try {
		const res = await api(
			`/api/flows/${encodeURIComponent(state.selectedFile)}/steps/${encodeURIComponent(stepId)}/rerecord/start`,
			{ method: 'POST' }
		)
		if (!res || !res.sessionId) throw new Error('后端没有返回重录会话号')
		const target = res.target || {}
		const targetIndex = Number(target.stepIndex)
		state.rerecord = {
			file: state.selectedFile,
			stepId,
			stepNo: Number.isFinite(targetIndex) ? targetIndex + 1 : no,
			title: target.title || step.title || `第 ${no} 步`,
			sessionId: String(res.sessionId),
			startUrl: res.startUrl || '',
			phase: 'recording',
		}
		setBanner({
			type: 'info',
			message: '正在录制备选动作…请在新窗口里操作到目标位置，然后点「停止并选择这一步」',
			actions: [
				{ action: 'rerecord-stop', label: '停止并选择', variant: 'primary' },
				{ action: 'rerecord-cancel', label: '取消' },
			],
			dismissible: false,
		})
		toast('重录已开始，请在浏览器窗口里操作', 'success')
	} catch (err) {
		showErrorBanner(`开始重录失败：${err.message}`, () => startRerecord(stepId))
	}
	renderAll()
}

async function stopRerecord() {
	const session = state.rerecord
	if (!session || session.phase !== 'recording') return
	session.phase = 'stopping'
	setBannerBusy(true)
	renderAll()

	try {
		const res = await api(
			`/api/flows/${encodeURIComponent(session.file)}/steps/${encodeURIComponent(session.stepId)}/rerecord/stop`,
			{ method: 'POST', body: { sessionId: session.sessionId } }
		)
		const candidates = res && Array.isArray(res.candidates) ? res.candidates : []
		const tempFile = res && res.tempFile ? String(res.tempFile) : ''
		setBanner(null)
		session.phase = 'choosing'
		renderAll()

		if (!candidates.length || !tempFile) {
			await noticeDialog({
				title: '这次没有录到操作',
				body: '浏览器已经关掉了，但这次没有录到可以替换的动作。请再点该步骤的「重录」，在新窗口里走到目标位置、做出要替换的那个操作，再点「停止并选择这一步」。',
				confirmText: '知道了',
			})
			await cleanupRerecordSession(session)
			return
		}

		const chosen = await rerecordCandidatesDialog({ session, candidates, tempFile })
		if (!chosen) {
			await cleanupRerecordSession(session)
			return
		}
		state.rerecord = null
		toast(`已替换第 ${session.stepNo} 步，建议跑一次自检`, 'success')
		await applyFlowResult(chosen.res)
		void loadFlows({ silent: true })
	} catch (err) {
		session.phase = 'recording'
		setBanner({
			type: 'error',
			message: `停止重录失败：${err.message}`,
			actions: [
				{ action: 'rerecord-stop', label: '重试停止', variant: 'primary' },
				{ action: 'rerecord-cancel', label: '取消重录' },
			],
			dismissible: false,
		})
	}
	renderAll()
}

async function cancelRerecord() {
	const session = state.rerecord
	if (!session) return
	await cleanupRerecordSession(session)
	toast('已取消重录，临时录制文件已清理', 'info')
}

/** 关闭/放弃重录会话：尽力让后端关浏览器、删临时文件，失败不打扰用户 */
async function cleanupRerecordSession(session) {
	if (session && session.sessionId) {
		try {
			await api(
				`/api/flows/${encodeURIComponent(session.file)}/steps/${encodeURIComponent(session.stepId)}/rerecord/cancel`,
				{ method: 'POST', body: { sessionId: session.sessionId } }
			)
		} catch {
			/* 会话可能已结束，忽略 */
		}
	}
	state.rerecord = null
	setBanner(null)
	renderAll()
}

/** 通用"知道了"提示弹窗（候选为空等） */
function noticeDialog(options) {
	const cfg = options || {}
	return new Promise((resolve) => {
		const modal = createModal({
			name: 'notice',
			dialogClass: 'modal-prompt',
			title: cfg.title || '提示',
			bodyHtml: `<p class="dialog-lead">${esc(cfg.body || '')}</p>`,
			actionsHtml: `<button type="button" class="btn btn-primary" data-dialog-action="ok">${esc(cfg.confirmText || '知道了')}</button>`,
			onClose: () => resolve(true),
		})
		const okButton = modal.root.querySelector('[data-dialog-action="ok"]')
		okButton.addEventListener('click', () => modal.close(true))
		okButton.focus()
	})
}

/** 候选动作单选弹窗：确认时直接 POST replace，失败在弹窗内联展示 */
function rerecordCandidatesDialog(options) {
	const cfg = options || {}
	const session = cfg.session || {}
	const candidates = Array.isArray(cfg.candidates) ? cfg.candidates : []
	const maps = stepTitleMaps()
	const originalStep = maps.byId.get(session.stepId)
	const originalKind = originalStep ? originalStep.kind : ''
	let preselected = candidates.findIndex((item) => item && item.kind === originalKind)
	if (preselected < 0) preselected = 0

	const itemsHtml = candidates
		.map((item, index) => {
			const no = index + 1
			const kindText = KIND_TEXT[item.kind] || (item.kind ? String(item.kind) : '')
			const description = item.description ? String(item.description) : ''
			const expect = item.expect ? `校验：${humanizeExpect(item.expect)}` : ''
			const thumb = assetUrl(item.screenshot)
			const meta = [kindText, description, expect].filter(Boolean).join(' · ')
			return `<label class="candidate-item">
				<input type="radio" name="rerecord-candidate" value="${esc(item.id)}" ${index === preselected ? 'checked' : ''} />
				<span class="candidate-no">${no}</span>
				<span class="candidate-main">
					<span class="candidate-title">${esc(item.title || `候选动作 ${no}`)}</span>
					${meta ? `<span class="candidate-meta">${esc(meta)}</span>` : ''}
				</span>
				${thumb ? `<img class="candidate-thumb" src="${esc(thumb)}" alt="" loading="lazy" />` : ''}
			</label>`
		})
		.join('')

	return new Promise((resolve) => {
		const modal = createModal({
			name: 'rerecord-candidates',
			dialogClass: 'modal-candidates',
			title: `选择要替换第 ${session.stepNo} 步的动作`,
			bodyHtml: `<p class="dialog-lead">下面是这次录到的动作。选一个最接近原来那一步的，用它替换第 ${session.stepNo} 步；这一步的编号和引用不会变。</p>
				<div class="candidate-list" role="radiogroup" aria-label="候选动作">${itemsHtml}</div>
				<p class="dialog-error" id="rerecord-error" hidden></p>`,
			actionsHtml: `<button type="button" class="btn btn-ghost" data-dialog-action="cancel">放弃这次重录</button>
				<button type="button" class="btn btn-primary" data-dialog-action="confirm">用它替换第 ${session.stepNo} 步</button>`,
			onClose: (value) => resolve(value || null),
		})
		const list = modal.root.querySelector('.candidate-list')
		const errorNode = modal.root.querySelector('#rerecord-error')
		const confirmButton = modal.root.querySelector('[data-dialog-action="confirm"]')
		const cancelButton = modal.root.querySelector('[data-dialog-action="cancel"]')

		const submit = async () => {
			const checked = list.querySelector('input[name="rerecord-candidate"]:checked')
			const candidate = checked
				? candidates.find((item) => item && item.id === checked.value)
				: null
			if (!candidate) {
				errorNode.textContent = '请先选一个动作'
				errorNode.hidden = false
				return
			}
			confirmButton.disabled = true
			confirmButton.innerHTML = '<span class="spinner"></span>正在替换…'
			errorNode.hidden = true
			try {
				const res = await api(
					`/api/flows/${encodeURIComponent(session.file)}/steps/${encodeURIComponent(session.stepId)}/replace`,
					{ method: 'POST', body: { tempFile: cfg.tempFile, tempStepId: candidate.id } }
				)
				modal.close({ res, candidate })
			} catch (err) {
				confirmButton.textContent = `用它替换第 ${session.stepNo} 步`
				confirmButton.disabled = false
				errorNode.textContent = err.message
				errorNode.hidden = false
			}
		}

		confirmButton.addEventListener('click', () => void submit())
		cancelButton.addEventListener('click', () => modal.close(null))
		confirmButton.focus()
	})
}

/* --------------------------- CSV 批量执行 -------------------------------- */

const BATCH_STATUS_TEXT = { running: '运行中', done: '已完成', stopped: '已停止', error: '出错' }
const CSV_DELIMITER_TEXT = { ',': '逗号', ';': '分号', '\t': '制表符' }
const BATCH_PREVIEW_ROWS = 5
const BATCH_PREVIEW_MAX_ROWS = 5000

let batchModalHandle = null
let batchTextTimer = null

function createBatchState() {
	return {
		file: '',
		ui: 'setup', // setup | progress
		csvText: '',
		csvFileName: '',
		preview: null, // { headers, rows, total, delimiter, warnings }
		mapping: Object.create(null), // 变量名 -> CSV 列名
		options: { showBrowser: false, continueOnFailure: true, rowDelayMs: 0 },
		starting: false,
		error: '',
		id: '',
		total: 0,
		data: null,
		stopRequested: false,
		filterFailedOnly: false,
		pollError: '',
		notified: false,
		lastPollAt: 0,
	}
}

function isBatchRunning() {
	return Boolean(
		state.batch &&
			state.batch.id &&
			state.batch.data &&
			state.batch.data.status === 'running'
	)
}

function isBatchBusy() {
	return Boolean(state.batch && (state.batch.starting || isBatchRunning()))
}

/** 只要批次还没结束（含尚未拿到第一份状态），就保持轮询 */
function isBatchPollingNeeded() {
	const batch = state.batch
	if (!batch || !batch.id) return false
	if (!batch.data) return true
	return batch.data.status === 'running'
}

function normalizeHeaderKey(value) {
	return String(value || '')
		.toLowerCase()
		.replace(/\s+/g, '')
}

function firstCsvLine(text) {
	let inQuotes = false
	const raw = String(text || '')
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index]
		if (char === '"') {
			if (inQuotes && raw[index + 1] === '"') index += 1
			else inQuotes = !inQuotes
		} else if (!inQuotes && (char === '\n' || char === '\r')) {
			return raw.slice(0, index)
		}
	}
	return raw
}

function countOutsideQuotes(line, delimiter) {
	let count = 0
	let inQuotes = false
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]
		if (char === '"') {
			if (inQuotes && line[index + 1] === '"') index += 1
			else inQuotes = !inQuotes
		} else if (!inQuotes && char === delimiter) {
			count += 1
		}
	}
	return count
}

/** 本地预览用的轻量 CSV 解析（真正解析以服务端为准；这里只为预览/自动映射） */
function detectCsvDelimiter(text) {
	const line = firstCsvLine(text)
	let best = ','
	let bestCount = 0
	for (const candidate of [',', ';', '\t']) {
		const count = countOutsideQuotes(line, candidate)
		if (count > bestCount) {
			best = candidate
			bestCount = count
		}
	}
	return best
}

function parseCsvPreview(text) {
	const raw = String(text || '').replace(/^\uFEFF/, '')
	if (!raw.trim()) return null
	const delimiter = detectCsvDelimiter(raw)
	const records = []
	let record = []
	let field = ''
	let inQuotes = false
	let index = 0
	while (index < raw.length) {
		const char = raw[index]
		if (inQuotes) {
			if (char === '"') {
				if (raw[index + 1] === '"') {
					field += '"'
					index += 2
					continue
				}
				inQuotes = false
				index += 1
				continue
			}
			field += char
			index += 1
			continue
		}
		if (char === '"') {
			inQuotes = true
			index += 1
			continue
		}
		if (char === delimiter) {
			record.push(field)
			field = ''
			index += 1
			continue
		}
		if (char === '\r') {
			index += 1
			continue
		}
		if (char === '\n') {
			record.push(field)
			records.push(record)
			record = []
			field = ''
			index += 1
			continue
		}
		field += char
		index += 1
	}
	record.push(field)
	records.push(record)

	const clean = records.filter((cells) => cells.some((cell) => String(cell || '').trim() !== ''))
	if (!clean.length) return null

	const seen = new Map()
	const headers = clean[0].map((cell, cellIndex) => {
		let name = String(cell || '').trim() || `列${cellIndex + 1}`
		const count = (seen.get(name) || 0) + 1
		seen.set(name, count)
		if (count > 1) name = `${name}_${count}`
		return name
	})
	const dataRecords = clean.slice(1)
	const rows = []
	const warnings = []
	let mismatched = 0
	for (const cells of dataRecords) {
		if (rows.length >= BATCH_PREVIEW_MAX_ROWS) break
		if (cells.length !== headers.length) mismatched += 1
		const row = Object.create(null)
		headers.forEach((header, headerIndex) => {
			row[header] = cells[headerIndex] !== undefined ? String(cells[headerIndex]) : ''
		})
		rows.push(row)
	}
	if (mismatched > 0) {
		warnings.push(`有 ${mismatched} 行的列数和表头不一致，缺的列按空值处理（以服务端解析为准）`)
	}
	if (dataRecords.length > BATCH_PREVIEW_MAX_ROWS) {
		warnings.push(`本地只预览前 ${BATCH_PREVIEW_MAX_ROWS} 行，实际行数以服务端解析为准`)
	}
	return { headers, rows, total: dataRecords.length, delimiter, warnings }
}

function autoMapBatchVariables() {
	const batch = state.batch
	if (!batch || !batch.preview) return
	const mapping = Object.create(null)
	for (const variable of variableDefs()) {
		const name = String((variable && variable.name) || '')
		if (!name) continue
		const match = batch.preview.headers.find(
			(header) => normalizeHeaderKey(header) === normalizeHeaderKey(name)
		)
		mapping[name] = match || ''
	}
	batch.mapping = mapping
}

/* ------------------------------ 批量条 ---------------------------------- */

function renderBatchHost() {
	const host = $('batch-host')
	if (!host) return
	if (state.recording || !state.detail) {
		setHtml(host, '')
		return
	}
	const defs = variableDefs()
	if (!defs.length) {
		setHtml(host, '')
		return
	}
	const batch = state.batch && state.batch.file === state.selectedFile ? state.batch : null
	const running = Boolean(batch && batch.id && batch.data && batch.data.status === 'running')
	const starting = Boolean(batch && batch.starting)
	const finished = Boolean(batch && batch.id && batch.data && batch.data.status !== 'running')
	const busy =
		Boolean(state.recording) || isRunActive() || Boolean(state.login) || Boolean(state.rerecord)

	let label = '📄 批量运行（CSV）'
	if (starting) label = '📄 正在启动批量运行…'
	else if (running) {
		const data = batch.data
		const total = Number(data.total) || Number(batch.total) || 0
		label = `📄 批量运行中 ${Number(data.completed) || 0}/${total}`
	} else if (finished) {
		label = '📄 查看最近一批结果'
	}
	const hint = running
		? '批量运行中，其它操作暂时不可用'
		: `用一张 CSV 表格给这 ${defs.length} 个参数批量填值，每行跑一遍流程`
	setHtml(
		host,
		`<div class="batch-bar">
			<button type="button" class="btn btn-tiny btn-ghost batch-open" data-action="batch-open" ${busy ? 'disabled' : ''}>${esc(label)}</button>
			<span class="batch-hint">${esc(hint)}</span>
		</div>`
	)
}

/* ------------------------------ 弹窗外壳 --------------------------------- */

function openBatchModal() {
	if (!state.detail) {
		toast('先选一个流程', 'info')
		return
	}
	if (state.recording || isRunActive() || state.login || state.rerecord) {
		toast('录制 / 回放 / 登录 / 重录进行中，结束后再批量运行', 'info')
		return
	}
	if (!variableDefs().length) {
		toast('这个流程没有运行参数，不需要 CSV 批量', 'info')
		return
	}
	const file = state.selectedFile
	if (!state.batch || state.batch.file !== file) {
		state.batch = Object.assign(createBatchState(), { file })
	}
	state.batch.ui = state.batch.id ? 'progress' : 'setup'
	renderBatchModalShell()
	if (state.batch.id) void pollBatch(true)
	updateTicker()
}

function renderBatchModalShell() {
	const previousFocus = document.activeElement
	dom.modalRoot.innerHTML = `<div class="modal-overlay" data-modal="batch">
		<div class="modal-card modal-batch" role="dialog" aria-modal="true" aria-labelledby="modal-title">
			<h3 id="modal-title">批量运行（CSV）</h3>
			<div id="batch-modal-body" class="batch-modal-body"></div>
			<div class="modal-actions" id="batch-modal-actions"></div>
		</div>
	</div>`
	const overlay = dom.modalRoot.querySelector('.modal-overlay')
	const onKey = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			closeBatchModal()
		}
	}
	document.addEventListener('keydown', onKey)
	batchModalHandle = { previousFocus, onKey }
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) closeBatchModal()
	})
	renderBatchModal()
}

function closeBatchModal() {
	if (!batchModalHandle) return
	document.removeEventListener('keydown', batchModalHandle.onKey)
	const previousFocus = batchModalHandle.previousFocus
	batchModalHandle = null
	dom.modalRoot.innerHTML = ''
	if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
	renderBatchHost()
}

function renderBatchModal() {
	if (!batchModalHandle || !state.batch) return
	if (state.batch.ui === 'progress' && state.batch.id) renderBatchProgress()
	else renderBatchSetup()
}

/* ------------------------------ 配置阶段 --------------------------------- */

function renderBatchSetup() {
	const body = $('batch-modal-body')
	const actions = $('batch-modal-actions')
	if (!body || !actions) return
	const batch = state.batch
	if (!batch) return

	body.innerHTML = `<p class="dialog-lead">上传或粘贴一张 CSV：第一行是列名，每一行用一套参数值跑一遍这个流程（最多 2000 行）。</p>
		<div class="batch-source">
			<label class="batch-file-label">选择 CSV 文件
				<input type="file" id="batch-file" accept=".csv,text/csv" />
			</label>
			<span class="batch-or">或者粘贴内容</span>
			<textarea id="batch-text" class="batch-text" rows="3" spellcheck="false" placeholder="第一行是列名，例如：&#10;name,amount&#10;张三,1200"></textarea>
		</div>
		<div id="batch-preview-host" class="batch-preview"></div>
		<div class="batch-options">
			<label class="check" title="默认不打开浏览器，批量跑得更快"><input type="checkbox" id="batch-headed" ${batch.options.showBrowser ? 'checked' : ''} /> 显示浏览器窗口</label>
			<label class="check" title="某行失败后继续跑剩下的行"><input type="checkbox" id="batch-continue" ${batch.options.continueOnFailure ? 'checked' : ''} /> 某行失败后继续</label>
			<label class="select-wrap" title="每行之间等多久，企业系统可以设 200-500ms 降低压力">行间隔
				<input type="number" id="batch-delay" class="batch-delay" min="0" max="5000" step="50" value="${Number(batch.options.rowDelayMs) || 0}" /> ms
			</label>
		</div>
		<div id="batch-mapping-host" class="batch-mapping"></div>
		<p class="dialog-error" id="batch-error" hidden></p>`

	const textarea = $('batch-text')
	if (textarea) textarea.value = batch.csvText || ''
	actions.innerHTML = `<button type="button" class="btn btn-ghost" data-action="batch-close">取消</button>
		<button type="button" class="btn btn-primary" data-action="batch-start" ${batch.starting ? 'disabled' : ''}>开始批量运行</button>`
	renderBatchPreviewHost()
	renderBatchMappingHost()
	if (batch.error) showBatchError(batch.error)
}

function renderBatchPreviewHost() {
	const host = $('batch-preview-host')
	if (!host) return
	const batch = state.batch
	if (!batch || !batch.preview) {
		setHtml(
			host,
			'<p class="batch-hint">还没有 CSV 内容：选择一个 .csv 文件，或把内容粘贴到上面。</p>'
		)
		return
	}
	const preview = batch.preview
	const headerCells = preview.headers.map((header) => `<th>${esc(header)}</th>`).join('')
	const bodyRows = preview.rows
		.slice(0, BATCH_PREVIEW_ROWS)
		.map(
			(row, rowIndex) =>
				`<tr><td class="batch-cell-no">${rowIndex + 1}</td>${preview.headers
					.map((header) => `<td>${esc(row[header])}</td>`)
					.join('')}</tr>`
		)
		.join('')
	const warnings = preview.warnings.length
		? `<ul class="batch-warnings">${preview.warnings.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
		: ''
	setHtml(
		host,
		`<div class="batch-preview-meta">共 <b>${preview.total}</b> 行 · ${preview.headers.length} 列 · 分隔符：${esc(
			CSV_DELIMITER_TEXT[preview.delimiter] || preview.delimiter
		)}${batch.csvFileName ? ` · 文件：${esc(batch.csvFileName)}` : ''}</div>
		<div class="batch-table-wrap">
			<table class="batch-table">
				<thead><tr><th class="batch-cell-no">#</th>${headerCells}</tr></thead>
				<tbody>${bodyRows}</tbody>
			</table>
		</div>
		<p class="batch-hint">上面只预览前 ${Math.min(BATCH_PREVIEW_ROWS, preview.rows.length)} 行，完整 ${preview.total} 行以服务端解析为准。</p>
		${warnings}`
	)
}

function renderBatchMappingHost() {
	const host = $('batch-mapping-host')
	if (!host) return
	const batch = state.batch
	const defs = variableDefs()
	if (!batch || !batch.preview || !defs.length) {
		setHtml(host, '')
		return
	}
	const rows = defs
		.map((variable) => {
			const name = String((variable && variable.name) || '')
			const mapped = batch.mapping[name] || ''
			const selected = batch.preview.headers.includes(mapped) ? mapped : ''
			const options = [
				'<option value="">（不映射）</option>',
				...batch.preview.headers.map(
					(header) =>
						`<option value="${esc(header)}" ${header === selected ? 'selected' : ''}>${esc(header)}</option>`
				),
			].join('')
			return `<label class="batch-map-row ${selected ? '' : 'is-missing'}" data-map-row="${esc(name)}">
				<code class="batch-map-var">${esc(name)}</code>
				<span class="batch-map-arrow">→</span>
				<select class="batch-map-select" data-var-map="${esc(name)}" aria-label="${esc(name)} 对应的 CSV 列">${options}</select>
				<span class="batch-map-missing">未匹配</span>
			</label>`
		})
		.join('')
	setHtml(
		host,
		`<div class="batch-map-title">变量 → CSV 列<span class="batch-hint">（默认按同名自动匹配，可以手动改）</span></div>${rows}`
	)
}

function setBatchCsvText(text, fileName) {
	const batch = state.batch
	if (!batch) return
	batch.csvText = String(text || '')
	if (fileName !== undefined) batch.csvFileName = String(fileName || '')
	batch.error = ''
	batch.preview = parseCsvPreview(batch.csvText)
	if (batch.preview) autoMapBatchVariables()
	renderBatchPreviewHost()
	renderBatchMappingHost()
	clearBatchError()
}

function onBatchTextInput(value) {
	const batch = state.batch
	if (!batch) return
	batch.csvText = String(value || '')
	batch.csvFileName = ''
	if (batchTextTimer) window.clearTimeout(batchTextTimer)
	batchTextTimer = window.setTimeout(() => {
		batchTextTimer = null
		if (!state.batch || state.batch !== batch) return
		batch.preview = parseCsvPreview(batch.csvText)
		if (batch.preview) autoMapBatchVariables()
		renderBatchPreviewHost()
		renderBatchMappingHost()
		clearBatchError()
	}, 160)
}

async function handleBatchFile(file) {
	if (!file) return
	const name = String(file.name || '')
	if (!/\.csv$/i.test(name) && file.type !== 'text/csv') {
		showBatchError('请选择 .csv 文件；如果是 Excel 表格，请先另存为 CSV 再上传。')
		return
	}
	try {
		const text = await file.text()
		setBatchCsvText(text, name)
	} catch (err) {
		showBatchError(`读取文件失败：${err && err.message ? err.message : err}`)
	}
}

function readBatchMapping() {
	const mapping = Object.create(null)
	const missing = []
	for (const variable of variableDefs()) {
		const name = String((variable && variable.name) || '')
		if (!name) continue
		const select = document.querySelector(
			`#batch-mapping-host select[data-var-map="${name}"]`
		)
		const column = select ? select.value : ''
		if (column) mapping[name] = column
		else missing.push(name)
	}
	return { mapping, missing }
}

function syncBatchStartButton() {
	const button = document.querySelector('#batch-modal-actions [data-action="batch-start"]')
	if (!button || !state.batch) return
	button.disabled = Boolean(state.batch.starting)
	button.innerHTML = state.batch.starting
		? '<span class="spinner"></span>正在启动…'
		: '开始批量运行'
}

function showBatchError(message) {
	const text = String(message || '')
	if (state.batch) state.batch.error = text
	const node = $('batch-error')
	if (!node) {
		if (text) toast(text, 'error')
		return
	}
	node.textContent = text
	node.hidden = !text
}

function clearBatchError() {
	if (state.batch) state.batch.error = ''
	const node = $('batch-error')
	if (!node) return
	node.textContent = ''
	node.hidden = true
}

async function startBatchRun() {
	const batch = state.batch
	if (!batch || batch.starting || !state.selectedFile) return
	if (!batch.csvText.trim()) {
		showBatchError('请先选择一个 .csv 文件，或者把 CSV 内容粘贴到上面。')
		return
	}
	if (!batch.preview || !batch.preview.total) {
		showBatchError('这份 CSV 里没有数据行（只有表头或者是空的），请检查一下。')
		return
	}
	const { mapping, missing } = readBatchMapping()
	if (missing.length) {
		showBatchError(
			`CSV 里缺少这些列：${missing.join('、')}。请重新选择文件，或在上面手动改一下「变量 → CSV 列」映射。`
		)
		return
	}
	clearBatchError()
	batch.starting = true
	syncBatchStartButton()

	try {
		const res = await api(
			`/api/flows/${encodeURIComponent(state.selectedFile)}/batch/start`,
			{
				method: 'POST',
				body: {
					csvText: batch.csvText,
					...(batch.csvFileName ? { fileName: batch.csvFileName } : {}),
					mapping,
					options: {
						headless: !batch.options.showBrowser,
						stopOnFailure: !batch.options.continueOnFailure,
						rowDelayMs: Math.max(0, Math.round(Number(batch.options.rowDelayMs) || 0)),
					},
				},
			}
		)
		if (!res || !res.batchId) throw new Error('后端没有返回批次编号')
		const total = Number(res.total) || (batch.preview ? batch.preview.total : 0)
		state.batch = Object.assign(batch, {
			id: String(res.batchId),
			file: state.selectedFile,
			total,
			ui: 'progress',
			data: normalizeBatchData({ status: 'running', total, rows: [] }),
			starting: false,
			stopRequested: false,
			notified: false,
			pollError: '',
			error: '',
			lastPollAt: 0,
			mapping: res.mapping && typeof res.mapping === 'object' ? res.mapping : mapping,
		})
		// 立刻刷新整体状态：禁用回放/录制/重录等入口
		renderAll()
		renderBatchModal()
		updateTicker()
		void pollBatch(true)
	} catch (err) {
		batch.starting = false
		syncBatchStartButton()
		showBatchError(err && err.message ? err.message : '启动批量运行失败')
	}
}

/* ------------------------------ 进度阶段 --------------------------------- */

function normalizeBatchData(data) {
	const payload = data && typeof data === 'object' ? data : {}
	const status = String(payload.status || '')
	return {
		status: ['running', 'done', 'stopped', 'error'].includes(status) ? status : 'running',
		total: Number(payload.total) || 0,
		completed: Number(payload.completed) || 0,
		okCount: Number(payload.okCount) || 0,
		failCount: Number(payload.failCount) || 0,
		rows: Array.isArray(payload.rows) ? payload.rows : [],
		startedAt: payload.startedAt ? String(payload.startedAt) : '',
		finishedAt: payload.finishedAt ? String(payload.finishedAt) : '',
		message: payload.message ? String(payload.message) : '',
	}
}

function renderBatchProgress() {
	const body = $('batch-modal-body')
	const actions = $('batch-modal-actions')
	const batch = state.batch
	if (!body || !actions || !batch || !batch.id) return

	const data = batch.data
	const status = data ? data.status : 'running'
	const running = status === 'running'
	const total = (data && Number(data.total)) || Number(batch.total) || 0
	const completed = data ? Number(data.completed) || 0 : 0
	const okCount = data ? Number(data.okCount) || 0 : 0
	const failCount = data ? Number(data.failCount) || 0 : 0
	const rows = data && Array.isArray(data.rows) ? data.rows : []
	const filtered = batch.filterFailedOnly ? rows.filter((row) => !row.ok) : rows
	const statusChipClass =
		status === 'done' ? 'chip-pass' : status === 'error' ? 'chip-fail' : status === 'stopped' ? 'chip-skip' : 'chip-running'
	const pending = Math.max(0, total - rows.length)
	const totalMs = rows.reduce((sum, row) => sum + (Number(row && row.ms) || 0), 0)

	const rowsHtml = filtered.length
		? filtered.map((row, index) => batchRowHtml(row, index)).join('')
		: `<p class="batch-hint">${
				batch.filterFailedOnly
					? '还没有失败的行。'
					: running
						? '正在跑第 1 行，结果会实时出现在这里…'
						: '这个批次没有行结果。'
			}</p>`

	const progressHtml = `<progress class="batch-progress" value="${completed}" max="${total || 1}"></progress>`
	const pollError = batch.pollError
		? `<p class="dialog-error" id="batch-poll-error">${esc(batch.pollError)}<button type="button" class="btn btn-tiny btn-ghost" data-action="batch-retry-poll">重试</button></p>`
		: ''

	const summaryHtml =
		running || !data
			? ''
			: `<div class="batch-summary ${failCount > 0 ? 'is-warn' : 'is-ok'}">
					<span class="batch-summary-title">${status === 'stopped' ? '已停止' : status === 'error' ? '批量运行出错' : '批量运行完成'}</span>
					<span>成功 <b>${okCount}</b> / 失败 <b>${failCount}</b> / 总耗时 ${esc(fmtDuration(totalMs))}</span>
					${data.message ? `<span class="batch-summary-msg">${esc(data.message)}</span>` : ''}
				</div>
				<div class="batch-export">
					<a class="btn btn-small btn-primary" href="/api/batches/${encodeURIComponent(batch.id)}/export.csv" download="batch-${esc(batch.id)}.csv">⬇ 导出结果 CSV</a>
					<span class="batch-hint">导出文件可以直接用 Excel 打开（含每行状态与失败原因）</span>
				</div>`

	body.innerHTML = `<div class="batch-progress-head">
			<span class="chip ${statusChipClass}">${esc(BATCH_STATUS_TEXT[status] || '运行中')}</span>
			<span class="batch-progress-counts">已完成 <b>${completed}</b>/${total} · 成功 ${okCount} · 失败 ${failCount}</span>
			${running ? '<span class="batch-hint">关闭这个窗口不会中断批量运行</span>' : ''}
		</div>
		${progressHtml}
		${pollError}
		${summaryHtml}
		<div class="batch-row-list">
			<div class="batch-row-list-head">
				<span class="batch-row-list-title">每行结果${pending ? `（还有 ${pending} 行在排队）` : ''}</span>
				<label class="check batch-filter"><input type="checkbox" id="batch-filter-failed" ${batch.filterFailedOnly ? 'checked' : ''} /> 只看失败行</label>
			</div>
			<div class="batch-rows">${rowsHtml}</div>
		</div>`

	if (running) {
		actions.innerHTML = `<button type="button" class="btn btn-ghost" data-action="batch-stop" ${batch.stopRequested ? 'disabled' : ''}>${batch.stopRequested ? '正在停止…' : '停止'}</button>
			<button type="button" class="btn btn-primary" data-action="batch-close">关闭（后台继续）</button>`
	} else {
		actions.innerHTML = `<button type="button" class="btn btn-ghost" data-action="batch-new">开始新的一批</button>
			<button type="button" class="btn btn-primary" data-action="batch-close">关闭</button>`
	}
}

function batchRowHtml(row, index) {
	const item = row || {}
	const rowIndex = Number(item.index) || index + 1
	const ok = Boolean(item.ok)
	const failed = item.failedStep || null
	const reason = failed
		? failed.reason
			? String(failed.reason)
			: failed.code
				? CODE_TEXT[String(failed.code)] || ''
				: ''
		: ''
	const ms = item.ms !== undefined && item.ms !== null ? item.ms : null
	const thumb = assetUrl(item.screenshot)
	const stepKind = failed && failed.kind ? KIND_TEXT[failed.kind] || failed.kind : ''
	return `<div class="batch-row ${ok ? 'batch-row-ok' : 'batch-row-fail'}">
		<span class="batch-row-no">${rowIndex}</span>
		<span class="chip chip-${ok ? 'pass' : 'fail'}">${ok ? '成功' : '失败'}</span>
		<span class="batch-row-main">
			${reason ? `<span class="batch-row-reason">${esc(reason)}</span>` : '<span class="batch-row-reason batch-row-ok-text">这一行跑完了</span>'}
			${!ok && stepKind ? `<span class="batch-row-step">失败步骤：${esc(stepKind)}</span>` : ''}
		</span>
		${ms !== null ? `<span class="step-ms">${fmtMs(ms)}</span>` : ''}
		${thumb ? `<button type="button" class="thumb-btn" data-action="zoom" data-src="${esc(thumb)}" data-name="第 ${rowIndex} 行失败截图" aria-label="查看第 ${rowIndex} 行的失败截图"><img src="${esc(thumb)}" alt="" loading="lazy" /></button>` : ''}
	</div>`
}

/* ------------------------------ 轮询/停止 -------------------------------- */

async function pollBatch(force) {
	const batch = state.batch
	if (!batch || !batch.id || state.busy.batch) return
	if (!force && batch.pollError && Date.now() - (batch.lastPollAt || 0) < 2000) return
	const batchId = batch.id
	batch.lastPollAt = Date.now()
	state.busy.batch = true

	try {
		const data = await api(`/api/batches/${encodeURIComponent(batchId)}`)
		if (!state.batch || state.batch.id !== batchId) return
		const previousStatus = state.batch.data ? state.batch.data.status : ''
		state.batch.data = normalizeBatchData(data)
		state.batch.pollError = ''
		const nextStatus = state.batch.data.status
		if (previousStatus !== nextStatus) {
			// running → done/stopped/error：恢复其它按钮与步骤区
			renderAll()
		} else {
			renderBatchHost()
		}
		if (state.batch.ui === 'progress' && batchModalHandle) renderBatchModal()
		notifyBatchFinished()
	} catch (err) {
		if (!state.batch || state.batch.id !== batchId) return
		state.batch.pollError = err && err.message ? err.message : '读取批次进度失败'
		if (state.batch.ui === 'progress' && batchModalHandle) renderBatchModal()
	} finally {
		state.busy.batch = false
		updateTicker()
	}
}

function notifyBatchFinished() {
	const batch = state.batch
	if (!batch || batch.notified) return
	const data = batch.data
	if (!data || data.status === 'running') return
	batch.notified = true
	if (data.status === 'error') {
		toast(`批量运行出错：${data.message || '原因见弹窗'}`, 'error')
		return
	}
	const parts = [`成功 ${data.okCount}`, `失败 ${data.failCount}`]
	toast(
		data.status === 'stopped' ? `批量运行已停止（${parts.join('，')}）` : `批量运行完成（${parts.join('，')}）`,
		data.failCount > 0 ? 'error' : 'success'
	)
}

async function stopBatchRun() {
	const batch = state.batch
	if (!batch || !batch.id || batch.stopRequested) return
	batch.stopRequested = true
	renderBatchModal()
	try {
		await api(`/api/batches/${encodeURIComponent(batch.id)}/stop`, { method: 'POST' })
		toast('已发送停止请求，当前这行跑完就停', 'info')
	} catch (err) {
		batch.stopRequested = false
		batch.pollError = `停止失败：${err && err.message ? err.message : err}`
		renderBatchModal()
		return
	}
	updateTicker()
	void pollBatch(true)
}

function resetBatchToSetup() {
	const batch = state.batch
	if (!batch || isBatchRunning()) return
	batch.ui = 'setup'
	batch.id = ''
	batch.data = null
	batch.total = 0
	batch.notified = false
	batch.stopRequested = false
	batch.error = ''
	batch.pollError = ''
	renderModalOrAll()
	updateTicker()
}

function renderModalOrAll() {
	if (batchModalHandle) renderBatchModal()
	renderAll()
}

/* ------------------------------ 事件处理 --------------------------------- */

function handleChange(event) {
	const target = event.target
	if (!(target instanceof HTMLElement)) return
	if (target instanceof HTMLInputElement && target.id === 'batch-file') {
		const file = target.files && target.files[0]
		if (file) void handleBatchFile(file)
		return
	}
	if (target instanceof HTMLSelectElement && target.matches('select[data-var-map]')) {
		const batch = state.batch
		if (!batch) return
		const name = target.getAttribute('data-var-map') || ''
		batch.mapping[name] = target.value
		const row = target.closest('.batch-map-row')
		if (row) row.classList.toggle('is-missing', !target.value)
		clearBatchError()
		return
	}
	if (!(target instanceof HTMLInputElement)) return
	if (target.id === 'batch-headed') {
		if (state.batch) state.batch.options.showBrowser = target.checked
		return
	}
	if (target.id === 'batch-continue') {
		if (state.batch) state.batch.options.continueOnFailure = target.checked
		return
	}
	if (target.id === 'batch-filter-failed') {
		if (state.batch) state.batch.filterFailedOnly = target.checked
		renderBatchModal()
	}
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
	state.suggestions = null
	state.suggestionsPhase = 'loading'
	state.suggestionsError = ''
	state.ignoredSuggestions = new Set()
	state.showIgnoredSuggestions = false
	if (state.batch && state.batch.file && state.batch.file !== file && !isBatchBusy()) {
		state.batch = null
	}
	ensureProfiles()
	renderAll()

	// detail 与 suggestions 并行拉取；建议失败只影响建议区，不阻塞主流程
	await Promise.all([loadDetail(file), loadSuggestions(file)])
	if (state.selectedFile !== file) return

	try {
		const url = new URL(window.location.href)
		url.searchParams.set('file', file)
		window.history.replaceState(null, '', url)
	} catch {
		/* 深链接不是关键功能，失败忽略 */
	}
	renderAll()
}

/** 拉流程详情；首次选择会重置变量默认值（reloadDetail 不重置） */
async function loadDetail(file) {
	const target = file || state.selectedFile
	if (!target) return
	try {
		const data = await api(`/api/flows/${encodeURIComponent(target)}`)
		if (state.selectedFile !== target) return
		state.detail = { flow: data.flow || {}, steps: Array.isArray(data.steps) ? data.steps : [] }
		state.detailPhase = 'ready'
		state.detailError = ''
		state.variables = buildVariables(data.flow)
	} catch (err) {
		if (state.selectedFile !== target) return
		state.detailPhase = 'error'
		state.detailError = err.message
	}
	renderAll()
}

/** 拉参数化建议（独立失败域：失败只在建议区提示，不影响回放/录制） */
async function loadSuggestions(file) {
	const target = file || state.selectedFile
	if (!target) return
	state.suggestionsPhase = 'loading'
	state.suggestionsError = ''
	renderAll()

	try {
		const data = await api(
			`/api/flows/${encodeURIComponent(target)}/suggestions?includeWeak=0`
		)
		if (state.selectedFile !== target) return
		state.suggestions = normalizeSuggestions(data)
		state.suggestionsPhase = 'ready'
		state.ignoredSuggestions = loadIgnoredSuggestions(target, suggestionVersion())
	} catch (err) {
		if (state.selectedFile !== target) return
		state.suggestions = null
		state.suggestionsPhase = 'error'
		state.suggestionsError = err.message
	}
	renderAll()
}

function normalizeSuggestions(data) {
	const payload = data || {}
	return {
		generatedAt: payload.generatedAt ? String(payload.generatedAt) : '',
		flowVersion: Number(payload.flowVersion) || 0,
		suggestions: Array.isArray(payload.suggestions)
			? payload.suggestions.filter((item) => item && item.stepId)
			: [],
		skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
	}
}

function suggestionVersion() {
	if (state.suggestions && state.suggestions.flowVersion) return state.suggestions.flowVersion
	const flow = state.detail && state.detail.flow
	return Number(flow && flow.version) || 0
}

function allSuggestions() {
	if (!state.suggestions || !Array.isArray(state.suggestions.suggestions)) return []
	return state.suggestions.suggestions
}

function isSuggestionIgnored(stepId) {
	return state.ignoredSuggestions.has(String(stepId || ''))
}

function activeSuggestions() {
	return allSuggestions().filter((item) => !isSuggestionIgnored(item.stepId))
}

function ignoredSuggestions() {
	return allSuggestions().filter((item) => isSuggestionIgnored(item.stepId))
}

function suggestionByStepId(stepId) {
	if (state.recording) return null
	const id = String(stepId || '')
	return allSuggestions().find((item) => item.stepId === id) || null
}

/* 忽略状态只存 localStorage，不写 IR（契约 §7.1）；key 含 file + flowVersion */
function ignoredStorageKey(file, version) {
	return `${IGNORED_STORAGE_PREFIX}:${file}@v${version}`
}

function loadIgnoredSuggestions(file, version) {
	const set = new Set()
	try {
		const raw = window.localStorage.getItem(ignoredStorageKey(file, version))
		if (!raw) return set
		const list = JSON.parse(raw)
		if (Array.isArray(list)) {
			for (const id of list) if (typeof id === 'string') set.add(id)
		}
	} catch {
		/* localStorage 不可用（隐私模式等）时降级为内存态 */
	}
	return set
}

function saveIgnoredSuggestions() {
	const file = state.selectedFile
	if (!file) return
	try {
		window.localStorage.setItem(
			ignoredStorageKey(file, suggestionVersion()),
			JSON.stringify([...state.ignoredSuggestions])
		)
	} catch {
		/* 忽略持久化失败，不影响当前会话 */
	}
}

/** apply 会让 flow.version+1，把忽略状态迁移到新版本，避免已忽略的建议"复活" */
function persistIgnoredForVersion(version) {
	const file = state.selectedFile
	if (!file) return
	try {
		window.localStorage.setItem(
			ignoredStorageKey(file, version),
			JSON.stringify([...state.ignoredSuggestions])
		)
	} catch {
		/* 忽略 */
	}
}

function setSuggestionIgnored(stepId, ignored) {
	const id = String(stepId || '')
	if (!id) return
	if (ignored) state.ignoredSuggestions.add(id)
	else state.ignoredSuggestions.delete(id)
	saveIgnoredSuggestions()
	renderAll()
	if (ignored) toast('已忽略这条建议，可以点「显示已忽略」找回', 'info')
}

function toggleIgnoredSuggestions() {
	state.showIgnoredSuggestions = !state.showIgnoredSuggestions
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
	// 步骤变了，建议也要重新算（失败只提示建议区）
	await loadSuggestions(state.selectedFile)
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

/** 归一化变量类型（secret 优先，未知类型回落到 string） */
function variableType(variable) {
	const item = variable || {}
	if (isSecretVariable(item)) return 'secret'
	const type = String(item.type || 'string')
	return VAR_TYPE_TEXT[type] ? type : 'string'
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
		if (dom.startBtn) dom.startBtn.disabled = hasActiveSession()
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
				${loginStateHtmlFor(originOfUrl(recording.url), { disabled: true })}
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
			${loginStateHtml()}
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

function confidenceKey(confidence) {
	const value = String(confidence || '').toLowerCase()
	return value === 'high' || value === 'medium' || value === 'weak' ? value : 'medium'
}

function truncateText(value, maxLength) {
	const text = String(value === null || value === undefined ? '' : value)
	if (text.length <= maxLength) return text
	return `${text.slice(0, maxLength)}…`
}

/** 步骤行里的「建议参数化」块：💡 建议参数化：name（高/中）+ 接受/修改/忽略 */
function suggestionInlineHtml(suggestion) {
	const stepId = String(suggestion.stepId || '')
	const ignored = isSuggestionIgnored(stepId)
	const confidence = CONFIDENCE_TEXT[suggestion.confidence] || ''
	const name = String(suggestion.suggestedName || '')
	const value = String(suggestion.currentValue || '')
	const groupCount =
		suggestion.group && Array.isArray(suggestion.group.stepIds) ? suggestion.group.stepIds.length : 0
	const reasons = Array.isArray(suggestion.reasons) ? suggestion.reasons.filter(Boolean) : []
	const reasonsHtml = reasons.length
		? `<details class="suggest-reasons"><summary>为什么这样建议</summary><ul>${reasons
				.map((reason) => `<li>${esc(reason)}</li>`)
				.join('')}</ul></details>`
		: ''
	const actions = ignored
		? `<button type="button" class="btn btn-tiny btn-ghost" data-action="suggest-restore" data-step-id="${esc(stepId)}">恢复建议</button>`
		: `<button type="button" class="btn btn-tiny btn-primary" data-action="suggest-accept" data-step-id="${esc(stepId)}">接受</button>
			<button type="button" class="btn btn-tiny btn-ghost" data-action="suggest-modify" data-step-id="${esc(stepId)}">修改</button>
			<button type="button" class="btn btn-tiny btn-ghost" data-action="suggest-ignore" data-step-id="${esc(stepId)}">忽略</button>`

	return `<div class="suggest-row${ignored ? ' is-ignored' : ''}" data-suggest-step="${esc(stepId)}">
		<div class="suggest-line">
			<span class="suggest-pill">💡 建议参数化</span>
			<code class="suggest-name">${esc(name || '未命名')}</code>
			${confidence ? `<span class="chip chip-conf-${confidenceKey(suggestion.confidence)}">置信${esc(confidence)}</span>` : ''}
			${groupCount > 1 ? `<span class="chip chip-kind">同值 ${groupCount} 处</span>` : ''}
			${ignored ? '<span class="chip chip-suggest-ignored">已忽略</span>' : ''}
			${value ? `<span class="suggest-value" title="${esc(value)}">当前值「${esc(truncateText(value, 26))}」</span>` : ''}
			<span class="suggest-buttons">${actions}</span>
		</div>
		${reasonsHtml}
	</div>`
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
	const suggestion = recording ? null : suggestionByStepId(item.id)
	const showSuggestion =
		suggestion && (state.showIgnoredSuggestions || !isSuggestionIgnored(suggestion.stepId))
	const suggestionHtml = showSuggestion ? suggestionInlineHtml(suggestion) : ''

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
					? '<div class="step-reason-hint">可以删掉这一步，也可以点右侧「重录」只重录这一步</div>'
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
			${suggestionHtml}
		</div>
		<div class="step-side">
			${badges.length ? `<div class="step-badges">${badges.join('')}</div>` : ''}
			${ms !== null ? `<span class="step-ms">${fmtMs(ms)}</span>` : ''}
		</div>
		<div class="step-extras">
			${thumb ? `<button type="button" class="thumb-btn" data-action="zoom" data-src="${esc(thumb)}" data-name="第 ${no} 步 ${esc(title)}" aria-label="查看这一步的截图"><img src="${esc(thumb)}" alt="" loading="lazy" /></button>` : ''}
			${
				allowDelete && item.id && item.kind !== 'group'
					? `<button type="button" class="btn btn-tiny btn-ghost" data-action="rerecord-start" data-step-id="${esc(item.id)}" ${rerecordBusy() ? 'disabled' : ''} title="只重录这一步，不用整条重来">重录</button>`
					: ''
			}
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
				.map((v) => `${v && v.name}:${(v && v.type) || ''}:${isSecretVariable(v) ? 's' : 'p'}`)
				.join(',')}`

	if (state.bottomKey !== signature) {
		state.bottomKey = signature
		host.innerHTML = bottomShellHtml()
		rendered.delete(host)
	}

	renderSuggestHost()
	renderVarsHost()
	renderBatchHost()
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
	<div id="suggest-host" class="suggest-host"></div>
	<div id="vars-host" class="vars-host"></div>
	<div id="batch-host" class="batch-host"></div>
	<div id="run-host" class="run-host"></div>`
}

/** 底部批量条：N 条建议 + 全部接受 + 显示已忽略；加载/失败/空态也在这里提示 */
function renderSuggestHost() {
	const host = $('suggest-host')
	if (!host) return

	if (state.recording || !state.detail) {
		setHtml(host, '')
		return
	}

	const phase = state.suggestionsPhase
	if (phase === 'loading' || phase === 'idle') {
		setHtml(
			host,
			'<div class="suggest-bar is-muted"><span class="spinner"></span>正在分析哪些值适合做运行参数…</div>'
		)
		return
	}

	if (phase === 'error') {
		setHtml(
			host,
			`<div class="suggest-bar is-error">
				<span>建议加载失败：${esc(state.suggestionsError || '未知原因')}</span>
				<span class="suggest-value">不影响回放，可以稍后重试</span>
				<button type="button" class="btn btn-tiny btn-ghost" data-action="suggest-retry">重试</button>
			</div>`
		)
		return
	}

	const total = allSuggestions().length
	if (!total) {
		const skipped = state.suggestions && Array.isArray(state.suggestions.skipped) ? state.suggestions.skipped : []
		const skippedHtml = skipped.length
			? `<details class="suggest-skipped"><summary>已跳过 ${skipped.length} 步</summary><ul>${skipped
					.slice(0, 20)
					.map((item) => `<li>${esc((item && item.reason) || '不适合参数化')}</li>`)
					.join('')}</ul></details>`
			: ''
		setHtml(
			host,
			`<div class="suggest-bar is-muted"><span>✅ 没有发现需要参数化的值</span>${skippedHtml}</div>`
		)
		return
	}

	const active = activeSuggestions()
	const ignored = ignoredSuggestions()
	const running = Boolean(
		state.run && (state.run.status === 'starting' || state.run.status === 'running')
	)
	const label = active.length
		? `<span class="suggest-batch-label">💡 参数化建议 <b>${active.length}</b> 条</span>
			<button type="button" class="btn btn-tiny btn-primary" data-action="suggest-accept-all" ${running ? 'disabled' : ''}>全部接受</button>`
		: `<span class="suggest-batch-label">建议都处理完了（已忽略 ${ignored.length} 条）</span>`
	const toggle = ignored.length
		? `<button type="button" class="btn btn-tiny btn-ghost" data-action="suggest-toggle-ignored">${
				state.showIgnoredSuggestions ? '隐藏已忽略' : `显示已忽略（${ignored.length}）`
			}</button>`
		: ''

	setHtml(host, `<div class="suggest-bar">${label}${toggle}</div>`)
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
	const type = variableType(item)
	const secret = type === 'secret'
	const hasDefault = !secret && typeof item.defaultValue === 'string' && item.defaultValue !== ''
	const note =
		type === 'file'
			? '填文件绝对路径'
			: secret
				? '输入时隐藏'
				: hasDefault
					? '已按默认值填好，可修改'
					: '必填'
	const typeChip = `<span class="chip chip-var chip-var-${esc(type)}" title="参数类型：${esc(VAR_TYPE_TEXT[type] || type)}">${esc(VAR_TYPE_TEXT[type] || type)}</span>`
	const placeholder = type === 'file' ? '例如 /Users/you/报价单.pdf' : secret ? '请输入' : ''
	const toggle = secret
		? `<button type="button" class="btn-eye" data-action="toggle-secret" data-target="${esc(name)}" aria-label="显示或隐藏 ${esc(name)}">显示</button>`
		: ''
	return `<div class="var-item">
		<span class="var-label">
			<code>${esc(name)}</code>${typeChip}<span class="var-note">${esc(note)}</span>
			<button type="button" class="btn btn-tiny btn-ghost var-rename" data-action="rename-var" data-name="${esc(name)}" title="给这个参数换个更好懂的名字">重命名</button>
		</span>
		<span class="var-input-row">
			<input type="${secret ? 'password' : 'text'}" data-var="${esc(name)}" ${secret ? 'data-secret="1"' : ''} autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" aria-label="${esc(name)}" />
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
	const sessionBusy = hasActiveSession()

	if (play) play.disabled = running || !hasFlow || sessionBusy
	if (selfCheck) selfCheck.disabled = running || !hasFlow || sessionBusy
	if (runs) runs.disabled = running || sessionBusy
	if (headed) headed.disabled = running || sessionBusy

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
	if (hasActiveSession()) {
		toast('请先完成或取消当前的登录 / 重录操作', 'info')
		return
	}
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
			url,
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
	if (hasActiveSession()) {
		toast('请先完成或取消当前的登录 / 重录操作', 'info')
		return
	}

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
	if (hasActiveSession()) {
		toast('登录 / 重录进行中，等结束再删除步骤', 'info')
		return
	}
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
		Boolean(state.run && state.run.runId && state.run.status === 'running') ||
		isBatchPollingNeeded()

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
		if (isBatchPollingNeeded()) void pollBatch()
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
			if (hasActiveSession()) {
				toast('请先完成或取消当前的登录 / 重录操作', 'info')
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
		case 'suggest-accept':
			void openSuggestionDialog(target.getAttribute('data-step-id') || '', 'confirm')
			return
		case 'suggest-modify':
			void openSuggestionDialog(target.getAttribute('data-step-id') || '', 'name')
			return
		case 'suggest-ignore':
			setSuggestionIgnored(target.getAttribute('data-step-id') || '', true)
			return
		case 'suggest-restore':
			setSuggestionIgnored(target.getAttribute('data-step-id') || '', false)
			return
		case 'suggest-accept-all':
			void acceptAllSuggestions()
			return
		case 'suggest-toggle-ignored':
			toggleIgnoredSuggestions()
			return
		case 'suggest-retry':
			void loadSuggestions(state.selectedFile)
			return
		case 'rename-var':
			void renameVariable(target.getAttribute('data-name') || '')
			return
		case 'login-update':
			void startLoginUpdate()
			return
		case 'login-stop':
			void stopLogin()
			return
		case 'login-cancel':
			void cancelLogin()
			return
		case 'login-clear':
			void clearLoginProfile()
			return
		case 'rerecord-start':
			void startRerecord(target.getAttribute('data-step-id') || '')
			return
		case 'rerecord-stop':
			void stopRerecord()
			return
		case 'rerecord-cancel':
			void cancelRerecord()
			return
		case 'batch-open':
			void openBatchModal()
			return
		case 'batch-close':
			closeBatchModal()
			return
		case 'batch-start':
			void startBatchRun()
			return
		case 'batch-stop':
			void stopBatchRun()
			return
		case 'batch-new':
			resetBatchToSetup()
			return
		case 'batch-retry-poll':
			void pollBatch(true)
			return
		default:
			return
	}
}

function handleInput(event) {
	const target = event.target
	if (!(target instanceof HTMLElement)) return
	if (target instanceof HTMLTextAreaElement && target.id === 'batch-text') {
		onBatchTextInput(target.value)
		return
	}
	if (target instanceof HTMLInputElement && target.id === 'batch-delay') {
		if (state.batch) state.batch.options.rowDelayMs = Math.max(0, Number(target.value) || 0)
		return
	}
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
	document.addEventListener('change', handleChange)
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

	await Promise.all([loadConfig(), loadFlows(), loadProfiles({ silent: true })])

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
