/**
 * 录制本地 fixture 站的样本 flow（M1 回归集）。
 * 用法：先 `pnpm site`，再 `npx tsx scripts/record-local.ts [route ...]`
 */
import { resolve } from 'node:path'

import { record } from '@rr/recorder'

const base = `http://${process.env.RR_SITE_HOST ?? '127.0.0.1'}:${process.env.RR_SITE_PORT ?? '5173'}`

interface Sample {
	route: string
	drive: Parameters<typeof record>[0]['drive']
}

const samples: Sample[] = [
	{
		route: '/basic',
		drive: async (page) => {
			await page.getByTestId('field-full-name').fill('alice')
			await page.getByTestId('field-email').fill('alice@example.com')
			await page.getByTestId('submit-basic').click()
			await page.waitForTimeout(300)
		},
	},
	{
		route: '/iframe-same',
		drive: async (page) => {
			const inner = page.frameLocator('#same-frame')
			await inner.getByTestId('inner-name').fill('bob')
			await inner.getByTestId('inner-submit').click()
			await page.waitForTimeout(300)
		},
	},
	{
		route: '/shadow-closed',
		drive: async (page) => {
			// closed shadow 只能点到宿主：录制会记 host + 相对偏移，回放点 host 的同位置
			await page.locator('x-closed-card').click()
			await page.waitForTimeout(400)
			await page.getByTestId('outside-btn').click()
			await page.waitForTimeout(300)
		},
	},
	{
		route: '/custom-select',
		drive: async (page) => {
			await page.getByTestId('cs-trigger').click()
			await page.getByRole('option', { name: '上海' }).click()
			await page.waitForTimeout(200)
		},
	},
	{
		route: '/spa',
		drive: async (page) => {
			await page.getByTestId('spa-nav-detail').click()
			await page.waitForTimeout(200)
			await page.getByTestId('spa-nav-list').click()
			await page.waitForTimeout(200)
		},
	},
	{
		route: '/controlled',
		drive: async (page) => {
			await page.getByTestId('controlled-input').fill('hello-rr')
			await page.getByTestId('sync-btn').click()
			await page.waitForTimeout(200)
		},
	},
]

async function main(): Promise<void> {
	const only = process.argv.slice(2)
	const targets = only.length
		? samples.filter((s) => only.some((o) => s.route.includes(o)))
		: samples
	if (!targets.length) throw new Error(`没有匹配的样本：${only.join(', ')}`)

	for (const sample of targets) {
		const slug = sample.route.replace(/^\/+/, '')
		const out = resolve(`flows/local-${slug}.json`)
		console.log(`\n▶ 录制 ${sample.route} → flows/local-${slug}.json`)
		const { flow } = await record({
			startUrl: `${base}${sample.route}`,
			outPath: out,
			headless: true,
			drive: sample.drive,
			onStep: (step) => console.log(`  + ${step.kind} ${step.id}`),
		})
		console.log(`  ✓ ${flow.steps.length} 步`)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
