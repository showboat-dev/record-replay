import { describe, expect, it } from 'vitest'

import {
	DEFAULT_SITE_HOST,
	DEFAULT_SITE_PORT,
	LOCAL_ROUTES,
	PUBLIC_SITES,
	isLocalSite,
	localSites,
	publicSites,
	routeToFlowPath,
	routeToSiteId,
	selectSites,
	siteOrigin,
} from './index.js'

const NO_ENV: NodeJS.ProcessEnv = {}

describe('LOCAL_ROUTES / localSites', () => {
	it('本地站正好 11 条，路由唯一', () => {
		expect(LOCAL_ROUTES).toHaveLength(11)
		const routes = LOCAL_ROUTES.map((route) => route.route)
		expect(new Set(routes).size).toBe(11)
		// 路由都是绝对路径形式，避免拼出 http://host:5173basic
		for (const route of routes) expect(route.startsWith('/')).toBe(true)
	})

	it('11 条路由就是我们约定的那 11 个难场景', () => {
		expect(LOCAL_ROUTES.map((route) => route.route)).toEqual([
			'/basic',
			'/iframe-same',
			'/iframe-cross',
			'/shadow-closed',
			'/canvas',
			'/virtual-list',
			'/controlled',
			'/custom-select',
			'/upload-download',
			'/dialog',
			'/spa',
		])
	})

	it('每条本地站都有 id / flowPath / url，且 URL 指向 fixture 站', () => {
		const sites = localSites(NO_ENV)
		expect(sites).toHaveLength(11)
		expect(new Set(sites.map((site) => site.id)).size).toBe(11)
		const origin = `http://${DEFAULT_SITE_HOST}:${DEFAULT_SITE_PORT}`
		for (const site of sites) {
			expect(site.flowPath).toBe(`flows/${site.id}.json`)
			expect(site.flowPath.startsWith('flows/local-')).toBe(true)
			expect(site.url?.startsWith(`${origin}/`)).toBe(true)
			expect(site.local).toBe(true)
			expect(site.public).toBe(false)
		}
	})

	it('id 与路由的映射符合 flows/local-<route>.json 约定', () => {
		expect(routeToSiteId('/iframe-cross')).toBe('local-iframe-cross')
		expect(routeToFlowPath('/iframe-cross')).toBe('flows/local-iframe-cross.json')
		expect(routeToSiteId('basic')).toBe('local-basic')
	})

	it('跟随 fixture 站的 RR_SITE_HOST / RR_SITE_PORT', () => {
		const sites = localSites({ RR_SITE_HOST: 'localhost', RR_SITE_PORT: '6000' })
		expect(sites[0]?.url).toBe('http://localhost:6000/basic')
		expect(siteOrigin({ RR_SITE_HOST: 'localhost', RR_SITE_PORT: '6000' })).toBe(
			'http://localhost:6000',
		)
	})

	it('端口非法时回落到默认端口（harness 不该被一个坏 env 弄崩）', () => {
		expect(siteOrigin({ RR_SITE_PORT: 'abc' })).toBe(`http://${DEFAULT_SITE_HOST}:${DEFAULT_SITE_PORT}`)
		expect(siteOrigin({ RR_SITE_PORT: '0' })).toBe(`http://${DEFAULT_SITE_HOST}:${DEFAULT_SITE_PORT}`)
		expect(siteOrigin({ RR_SITE_PORT: '70000' })).toBe(`http://${DEFAULT_SITE_HOST}:${DEFAULT_SITE_PORT}`)
	})
})

describe('PUBLIC_SITES / publicSites', () => {
	it('公开站正好 9 条占位，url 都是 https', () => {
		expect(PUBLIC_SITES).toHaveLength(9)
		const sites = publicSites()
		expect(new Set(sites.map((site) => site.id)).size).toBe(9)
		for (const site of sites) {
			expect(site.url?.startsWith('https://')).toBe(true)
			expect(site.public).toBe(true)
			expect(site.local).toBe(false)
			expect(site.flowPath).toBe(`flows/${site.id}.json`)
		}
	})

	it('publicSites 返回副本，改它不会污染清单', () => {
		const first = publicSites()
		const head = first[0]
		expect(head).toBeDefined()
		if (head) head.url = 'https://changed.example/'
		expect(publicSites()[0]?.url).not.toBe('https://changed.example/')
	})
})

describe('selectSites', () => {
	it('local 模式只返回本地 11 条', () => {
		const sites = selectSites('local', { env: NO_ENV })
		expect(sites).toHaveLength(11)
		expect(sites.every((site) => site.local === true)).toBe(true)
	})

	it('public 模式只返回公开 9 条', () => {
		const sites = selectSites('public', { env: NO_ENV })
		expect(sites).toHaveLength(9)
		expect(sites.every((site) => site.public === true)).toBe(true)
	})

	it('all 模式 = 11 + 9 = 20，且 id 不重复', () => {
		const sites = selectSites('all', { env: NO_ENV })
		expect(sites).toHaveLength(20)
		expect(new Set(sites.map((site) => site.id)).size).toBe(20)
		// 本地站在前、公开站在后
		expect(sites[0]?.id).toBe('local-basic')
		expect(sites[11]?.id).toBe('public-example')
	})

	it('默认模式是 local（绝不默认联网）', () => {
		expect(selectSites(undefined, { env: NO_ENV })).toHaveLength(11)
	})
})

describe('isLocalSite', () => {
	it('显式 local 优先，其次按 url 推断', () => {
		expect(isLocalSite({ id: 'a', flowPath: 'flows/a.json', local: true })).toBe(true)
		expect(isLocalSite({ id: 'b', flowPath: 'flows/b.json', local: false })).toBe(false)
		expect(isLocalSite({ id: 'c', flowPath: 'flows/c.json', url: 'http://127.0.0.1:5173/basic' })).toBe(
			true,
		)
		expect(isLocalSite({ id: 'd', flowPath: 'flows/d.json', url: 'https://example.com/' })).toBe(false)
	})
})
