/**
 * 站点清单（回归集的"考卷目录"）。
 *
 * 两类站点：
 * - **本地站**（11 条，`fixtures/site` 的路由）：完全离线，M1 回归的主力。URL 跟随 fixture
 *   站的环境变量（RR_SITE_HOST / RR_SITE_PORT），保证 `pnpm site` 换了端口之后 harness 也跟得上。
 * - **公开站**（9 条占位）：只写 id / url / flowPath，**默认永远不联网跑**；只有显式
 *   `--sites all` 且 `flows/public-<id>.json` 真的存在时才会跑（见 runHarness）。
 *
 * flow 命名约定：`flows/local-<route>.json` / `flows/public-<id>.json`。
 * 没有 flow 的站点不报错——由 runHarness 标成 `missing`（本地）/ `skipped`（公开）
 * 并在报告里列出来，这样"还没录"和"录了但跑挂了"在报告里是两个不同的状态。
 */
import type { SiteSpec } from './types.js'

/** 本地 fixture 站的默认地址（与 fixtures/site/server.ts 的默认值保持一致） */
export const DEFAULT_SITE_HOST = '127.0.0.1'
export const DEFAULT_SITE_PORT = 5173

export type SiteMode = 'local' | 'all' | 'public'

export interface LocalRoute {
	/** 路由（以 / 开头） */
	route: string
	/** 这个页面用来测什么（给人看的，也用于报告里的说明） */
	describe: string
}

/**
 * 11 个本地难场景路由（与 T2「fixture 测试站」的交付清单一一对应）。
 * 顺序即报告默认顺序：从最基础的 /basic 开始，越往后越"刁钻"。
 */
export const LOCAL_ROUTES: readonly LocalRoute[] = [
	{ route: '/basic', describe: '普通表单：文本/密码/邮箱/textarea/原生 select/checkbox/radio/提交' },
	{ route: '/iframe-same', describe: '同源 iframe：父页与 /inner-form 内各自有按钮与输入框' },
	{ route: '/iframe-cross', describe: '跨域 iframe（5174 次站）：CORS 下的元素定位' },
	{ route: '/shadow-closed', describe: 'closed shadow DOM：只能拿到 host 的降级路径' },
	{ route: '/canvas', describe: 'canvas 色块：只能按坐标点选' },
	{ route: '/virtual-list', describe: '虚拟列表 1000 条只渲染 20 条：滚动后元素复用' },
	{ route: '/controlled', describe: '手写受控输入：绕过 value setter + dispatch input' },
	{ route: '/custom-select', describe: 'div 假下拉：展开/选项都是 div' },
	{ route: '/upload-download', describe: 'file input + blob 下载' },
	{ route: '/dialog', describe: 'confirm / 自定义 modal 的确认与取消' },
	{ route: '/spa', describe: 'history.pushState 两个视图，切换重建 DOM' },
] as const

/**
 * 9 个公开站占位（真实回归集）。**默认不跑**：只有 `--sites all` 且 flow 已录制时才会联网。
 * 选型标准：结构稳定、无登录、常年可用，覆盖 docs/电商/社区/列表页/复杂组件。
 */
export const PUBLIC_SITES: readonly SiteSpec[] = [
	{ id: 'public-example', flowPath: 'flows/public-example.json', url: 'https://example.com/', local: false, public: true },
	{ id: 'public-playwright-docs', flowPath: 'flows/public-playwright-docs.json', url: 'https://playwright.dev/', local: false, public: true },
	{ id: 'public-wikipedia', flowPath: 'flows/public-wikipedia.json', url: 'https://en.wikipedia.org/wiki/Main_Page', local: false, public: true },
	{ id: 'public-hacker-news', flowPath: 'flows/public-hacker-news.json', url: 'https://news.ycombinator.com/', local: false, public: true },
	{ id: 'public-the-internet', flowPath: 'flows/public-the-internet.json', url: 'https://the-internet.herokuapp.com/', local: false, public: true },
	{ id: 'public-demoqa', flowPath: 'flows/public-demoqa.json', url: 'https://demoqa.com/', local: false, public: true },
	{ id: 'public-saucedemo', flowPath: 'flows/public-saucedemo.json', url: 'https://www.saucedemo.com/', local: false, public: true },
	{ id: 'public-todomvc', flowPath: 'flows/public-todomvc.json', url: 'https://todomvc.com/examples/react/dist/', local: false, public: true },
	{ id: 'public-github', flowPath: 'flows/public-github.json', url: 'https://github.com/microsoft/playwright', local: false, public: true },
] as const

/** 路由 → 站点 id（`/iframe-cross` → `local-iframe-cross`） */
export function routeToSiteId(route: string): string {
	return `local-${route.replace(/^\/+/, '')}`
}

/** 路由 → flow 路径（`/iframe-cross` → `flows/local-iframe-cross.json`） */
export function routeToFlowPath(route: string): string {
	return `flows/${routeToSiteId(route)}.json`
}

/**
 * 本地站 origin。环境变量与 fixture server 完全对齐：
 * `RR_SITE_HOST`（默认 127.0.0.1）、`RR_SITE_PORT`（默认 5173）。
 * 端口非法时回落到默认值而不是抛错——harness 不该因为一个坏 env 直接崩掉。
 */
export function siteOrigin(env: NodeJS.ProcessEnv = process.env): string {
	const host = env.RR_SITE_HOST?.trim() || DEFAULT_SITE_HOST
	const rawPort = env.RR_SITE_PORT?.trim()
	const parsed = rawPort ? Number(rawPort) : DEFAULT_SITE_PORT
	const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_SITE_PORT
	return `http://${host}:${port}`
}

/** 11 条本地站（离线，默认集合） */
export function localSites(env: NodeJS.ProcessEnv = process.env): SiteSpec[] {
	const origin = siteOrigin(env)
	return LOCAL_ROUTES.map(({ route }) => ({
		id: routeToSiteId(route),
		flowPath: routeToFlowPath(route),
		url: `${origin}${route}`,
		local: true,
		public: false,
	}))
}

/** 9 条公开站占位（需要联网，默认不跑） */
export function publicSites(): SiteSpec[] {
	return PUBLIC_SITES.map((site) => ({ ...site }))
}

/**
 * 按模式取站点清单：
 * - `local`（默认）：只跑本地 11 条；
 * - `all`：本地 + 公开（公开站没有 flow 时会被 runHarness 标 skipped，不会联网）；
 * - `public`：只跑公开站（同样需要 flow）。
 */
export function selectSites(
	mode: SiteMode = 'local',
	opts: { env?: NodeJS.ProcessEnv } = {},
): SiteSpec[] {
	switch (mode) {
		case 'local':
			return localSites(opts.env)
		case 'public':
			return publicSites()
		case 'all':
			return [...localSites(opts.env), ...publicSites()]
		default: {
			// 用 never 兜住新增模式：将来加 mode 忘了改这里会直接编译失败
			const exhaustive: never = mode
			throw new Error(`未知的站点模式：${String(exhaustive)}`)
		}
	}
}

/** 站点是不是本地站（没有显式 local 字段时，用 url 判断） */
export function isLocalSite(site: SiteSpec): boolean {
	if (site.local !== undefined) return site.local
	return site.url === undefined || /^http:\/\/(127\.0\.0\.1|localhost)/.test(site.url)
}
