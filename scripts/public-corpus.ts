/**
 * 公网复杂站点语料库：录制 + 回放。
 *
 *   npx tsx scripts/public-corpus.ts record [id ...]   # 录 flow（默认全部）
 *   npx tsx scripts/public-corpus.ts run    [id ...] [--runs 3] [--json]
 *
 * 目标：用 10 个真实站点验证「录制 → 多级解析 → 校验」在复杂页面上的表现，
 * 而不只是本地 fixture。每个站点一条 3~12 步的操作链路。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Page } from 'playwright'

import { playRuns } from '@rr/executor'
import { record } from '@rr/recorder'
import { loadFlow, type Flow } from '@rr/schema'

interface Spec {
	id: string
	url: string
	title: string
	/** 录制时执行的链路（尽量用 getByRole / getByLabel / getByPlaceholder，模拟人） */
	drive: (page: Page) => Promise<void>
	/** 回放需要的变量（secret 不落盘） */
	vars?: Record<string, string>
	/** 单步超时（慢站点/SPA 需要更长），默认沿用 executor 的 15s */
	timeoutMs?: number
	/** 期望的期望步骤数下限，用于 sanity check */
	minSteps?: number
}

const wait = (page: Page, ms = 300): Promise<void> => page.waitForTimeout(ms)

const specs: Spec[] = [
	{
		id: 'saucedemo',
		url: 'https://www.saucedemo.com/',
		title: 'SauceDemo 登录→加购→购物车→结算→完成',
		vars: { password: 'secret_sauce' },
		minSteps: 10,
		drive: async (page) => {
			await page.locator('#user-name').fill('standard_user')
			await page.locator('#password').fill('secret_sauce')
			await page.locator('#login-button').click()
			await page.waitForSelector('[data-test="inventory-list"]')
			await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click()
			await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click()
			await wait(page)
			await page.locator('.shopping_cart_link').click()
			await page.waitForSelector('[data-test="checkout"]')
			await page.locator('[data-test="checkout"]').click()
			await page.locator('[data-test="firstName"]').fill('Alice')
			await page.locator('[data-test="lastName"]').fill('Demo')
			await page.locator('[data-test="postalCode"]').fill('12345')
			await page.locator('[data-test="continue"]').click()
			await page.waitForSelector('[data-test="finish"]')
			await page.locator('[data-test="finish"]').click()
			await page.waitForSelector('[data-test="complete-header"]')
			await wait(page)
		},
	},
	{
		id: 'demoqa-form',
		url: 'https://demoqa.com/automation-practice-form',
		title: 'DemoQA 长表单（文本框/单选/日期/多选/下拉/提交弹窗）',
		minSteps: 6,
		drive: async (page) => {
			await page.getByPlaceholder('First Name').fill('Alice')
			await page.getByPlaceholder('Last Name').fill('Demo')
			await page.getByPlaceholder('name@example.com').fill('alice@example.com')
			await page.getByLabel('Female', { exact: true }).check()
			await page.getByPlaceholder('Mobile Number').fill('13800138000')
			await page.locator('#dateOfBirthInput').fill('01 Jan 1990')
			await page.getByPlaceholder('Current Address').fill('Shanghai')
			await wait(page)
			await page.getByRole('button', { name: 'Submit' }).click()
			await page.waitForSelector('#example-modal-sizes-title-lg')
			await wait(page, 500)
		},
	},
	{
		id: 'selenium-web-form',
		url: 'https://www.selenium.dev/selenium/web/web-form.html',
		title: 'Selenium 官方表单页（文本/密码/下拉/复选/单选/提交）',
		vars: { password: 'secret' },
		minSteps: 5,
		drive: async (page) => {
			await page.getByLabel('Text input').fill('hello rr')
			await page.getByLabel('Password').fill('secret')
			await page.getByLabel('Textarea').fill('multi-step record and replay')
			await page.locator('select[name="my-select"]').selectOption({ label: 'Two' })
			await page.locator('input[type="checkbox"]').first().check()
			await page.locator('input[type="radio"]').first().check()
			await wait(page)
			await page.getByRole('button', { name: 'Submit' }).click()
			await wait(page, 500)
		},
	},
	{
		id: 'todomvc',
		url: 'https://demo.playwright.dev/todomvc/',
		title: 'TodoMVC（动态列表：新增/勾选/筛选/清除）',
		minSteps: 5,
		drive: async (page) => {
			const input = page.getByPlaceholder('What needs to be done?')
			await input.fill('record flow')
			await input.press('Enter')
			await input.fill('replay flow')
			await input.press('Enter')
			await input.fill('verify flow')
			await input.press('Enter')
			await page.getByRole('checkbox', { name: 'Toggle Todo' }).first().check()
			await wait(page)
			await page.getByRole('link', { name: 'Active' }).click()
			await wait(page)
			await page.getByRole('link', { name: 'Completed' }).click()
			await wait(page)
		},
	},
	{
		id: 'wikipedia',
		url: 'https://en.wikipedia.org/wiki/Main_Page',
		title: 'Wikipedia 搜索 → 打开条目 → 页内导航',
		timeoutMs: 30_000,
		minSteps: 3,
		drive: async (page) => {
			await page.getByRole('searchbox', { name: /Search/i }).fill('Playwright (software)')
			await page.getByRole('searchbox', { name: /Search/i }).press('Enter')
			await page.waitForSelector('#firstHeading')
			await wait(page)
			await page
				.getByRole('link', { name: /Microsoft/i })
				.first()
				.click()
			await page.waitForSelector('#firstHeading')
			await wait(page, 500)
		},
	},
	{
		id: 'orangehrm',
		url: 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login',
		title: 'OrangeHRM 企业后台（登录 → 仪表盘 → My Info → 联系信息）',
		vars: { password: 'admin123' },
		timeoutMs: 45_000,
		minSteps: 5,
		drive: async (page) => {
			await page.getByPlaceholder('Username').fill('Admin')
			await page.getByPlaceholder('Password').fill('admin123')
			await page.getByRole('button', { name: 'Login' }).click()
			await page.waitForURL(/\/dashboard/, { timeout: 30_000 })
			await page.waitForTimeout(1200)
			await page.getByRole('link', { name: 'My Info' }).click()
			await page.waitForURL(/viewPersonalDetails/, { timeout: 30_000 })
			await page.waitForTimeout(1000)
			await page.getByRole('tab', { name: /Contact Details/i }).click()
			await page.waitForTimeout(1000)
		},
	},
	{
		id: 'playwright-dev',
		url: 'https://playwright.dev/',
		title: 'Playwright 文档站（导航 → 文档 → API 页）',
		minSteps: 2,
		drive: async (page) => {
			await page.getByRole('link', { name: 'Docs' }).first().click()
			await page.waitForSelector('article, .markdown')
			await wait(page)
			await page.getByRole('link', { name: 'API', exact: true }).first().click()
			await wait(page, 500)
		},
	},
	{
		id: 'antd-select',
		url: 'https://ant.design/components/select',
		title: 'AntD Select（div 假下拉：打开 → 选项 → 回填）',
		minSteps: 2,
		drive: async (page) => {
			const combo = page.getByRole('combobox').first()
			await combo.click()
			await wait(page, 700)
			await page.getByTitle('Lucy').first().click()
			await wait(page)
		},
	},
	{
		id: 'element-plus-select',
		url: 'https://element-plus.org/en-US/component/select.html',
		title: 'Element Plus Select（Vue 假下拉）',
		timeoutMs: 30_000,
		minSteps: 2,
		drive: async (page) => {
			const combo = page.locator('.el-select').first()
			await combo.click()
			await wait(page, 700)
			await page.locator('.el-select-dropdown__item').nth(1).click()
			await wait(page)
		},
	},
	{
		id: 'mui-autocomplete',
		url: 'https://mui.com/material-ui/react-autocomplete/',
		title: 'MUI Autocomplete（输入过滤 + 选中选项）',
		minSteps: 2,
		drive: async (page) => {
			const input = page.getByRole('combobox').first()
			await input.click()
			await input.fill('The Godfather')
			await page.getByRole('option', { name: 'The Godfather' }).first().click()
			await wait(page)
		},
	},
]

const arg = process.argv.slice(2)
const command = arg[0]
const ids = arg.slice(1).filter((a) => specs.some((spec) => spec.id === a))
const flag = (name: string): string | undefined => {
	const i = arg.indexOf(`--${name}`)
	return i >= 0 ? arg[i + 1] : undefined
}
const selected = ids.length ? specs.filter((s) => ids.includes(s.id)) : specs

function flowPath(spec: Spec): string {
	return resolve(`flows/public-${spec.id}.json`)
}

async function recordAll(): Promise<void> {
	let ok = 0
	for (const spec of selected) {
		const out = flowPath(spec)
		if (existsSync(out) && !arg.includes('--force')) {
			console.log(`= ${spec.id} 已有 flow（--force 可重录）`)
			continue
		}
		console.log(`\n▶ 录制 ${spec.id}：${spec.title}`)
		try {
			const { flow } = await record({
				startUrl: spec.url,
				outPath: out,
				headless: true,
				viewport: { width: 1440, height: 900 },
				drive: spec.drive,
				onStep: (step) => console.log(`  + ${step.kind.padEnd(8)} ${step.id}`),
			})
			const steps = flow.steps.length
			const bad = spec.minSteps && steps < spec.minSteps
			console.log(
				`  ✓ ${steps} 步${bad ? `（少于预期 ${spec.minSteps}）` : ''} → flows/public-${spec.id}.json`,
			)
			if (!bad) ok++
		} catch (err) {
			console.log(`  ✗ 录制失败：${(err as Error).message.split('\n')[0]}`)
		}
	}
	console.log(`\n录制完成：${ok}/${selected.length}`)
}

async function runAll(): Promise<void> {
	const runs = Number(flag('runs') ?? 3)
	const results: Array<Record<string, unknown>> = []
	for (const spec of selected) {
		const path = flowPath(spec)
		if (!existsSync(path)) {
			console.log(`· ${spec.id} 缺 flow，跳过`)
			continue
		}
		const flow: Flow = await loadFlow(path)
		const t0 = Date.now()
		try {
			const runResults = await playRuns({
				flow,
				runs,
				headless: true,
				...(spec.vars ? { variables: spec.vars } : {}),
				...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
			})
			const passed = runResults.filter((r) => r.ok).length
			const steps = runResults[0]?.steps.length ?? 0
			const levels = new Map<string, number>()
			for (const r of runResults)
				for (const s of r.steps)
					levels.set(s.level ?? 'none', (levels.get(s.level ?? 'none') ?? 0) + 1)
			const failed = runResults
				.flatMap((r) => r.steps.filter((s) => s.status !== 'pass'))
				.map((s) => `${s.stepId}:${s.error?.code ?? s.status}`)
			console.log(
				`${passed === runs ? '✓' : '✗'} ${spec.id.padEnd(22)} ${passed}/${runs}  ${steps} 步  ` +
					`${((Date.now() - t0) / 1000).toFixed(1)}s  levels=${JSON.stringify(Object.fromEntries(levels))}` +
					(failed.length ? `  fail=${failed.slice(0, 4).join(',')}` : ''),
			)
			results.push({
				site: spec.id,
				url: spec.url,
				passed,
				runs,
				steps,
				levels: Object.fromEntries(levels),
				failed,
			})
		} catch (err) {
			console.log(`✗ ${spec.id.padEnd(22)} 运行异常：${(err as Error).message.split('\n')[0]}`)
			results.push({ site: spec.id, url: spec.url, error: (err as Error).message })
		}
	}
	const totalRuns = results.reduce((n, r) => n + Number(r.runs ?? 0), 0)
	const passRuns = results.reduce((n, r) => n + Number(r.passed ?? 0), 0)
	console.log(`\n总计：${passRuns}/${totalRuns} runs 通过（${selected.length} 站点）`)
	if (flag('json')) console.log(JSON.stringify(results, null, 2))
}

if (command === 'record') await recordAll()
else if (command === 'run') await runAll()
else {
	console.error(
		'用法：npx tsx scripts/public-corpus.ts record|run [id ...] [--runs 3] [--force] [--json]',
	)
	process.exit(2)
}
