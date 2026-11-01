/**
 * 录制真实站点样本 flow（联网）。
 * 用法：`npx tsx scripts/record-public.ts saucedemo`
 *
 * saucedemo 链路（12+ 步，含登录 → 加购 → 结算 → 完成）：
 * 故意选了"登录 + 动态列表 + 表单 + 多页面跳转"，用来验证真实站点上的录放。
 * 密码由 recorder 自动转成 {{password}} secret 变量，回放时用 `--var password=...` 传。
 */
import { resolve } from 'node:path'

import { record } from '@rr/recorder'

type Drive = NonNullable<Parameters<typeof record>[0]['drive']>

const flows: Record<string, { url: string; title: string; drive: Drive }> = {
	saucedemo: {
		url: 'https://www.saucedemo.com/',
		title: 'SauceDemo 完整下单链路（登录→加购→购物车→结算→完成）',
		drive: async (page) => {
			await page.locator('#user-name').fill('standard_user')
			await page.locator('#password').fill('secret_sauce')
			await page.locator('#login-button').click()
			await page.waitForSelector('[data-test="inventory-list"]')

			await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click()
			await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click()
			await page.waitForTimeout(200)

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
			await page.waitForTimeout(300)
		},
	},
}

async function main(): Promise<void> {
	const name = process.argv[2]
	if (!name || !flows[name]) {
		console.error(`用法：npx tsx scripts/record-public.ts <${Object.keys(flows).join('|')}>`)
		process.exit(2)
	}
	const spec = flows[name]
	const out = resolve(`flows/public-${name}.json`)
	console.log(`▶ 录制 ${spec.url}`)
	const { flow } = await record({
		startUrl: spec.url,
		outPath: out,
		headless: true,
		viewport: { width: 1440, height: 900 },
		drive: spec.drive,
		onStep: (step) => console.log(`  + ${step.kind.padEnd(8)} ${step.id}`),
	})
	console.log(`\n✓ ${flow.steps.length} 步 → flows/public-${name}.json`)
	console.log(`  变量：${flow.variables.map((v) => v.name).join(', ') || '无'}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
