/**
 * URL 重定基（回放环境切换）。
 *
 * 录制产物里带的是**绝对 URL**（录在哪个端口就写哪个端口），但回放要跑在别的端口/环境
 * （fixture 站 5173、未来的 staging/prod）。`baseUrl` 只替换 **origin**，
 * path / query / hash 原样保留。
 *
 * 放在 resolver 里是因为 **iframe 的 urlPattern 也需要同一套重定基**
 * （录制时 frame.url 带 5199，回放在 5173），executor 从 `@rr/resolver` 复用。
 */
export function rebaseUrl(url: string, baseUrl?: string): string {
	if (!baseUrl) return url
	const trimmed = baseUrl.trim()
	if (trimmed === '') return url

	let base: URL
	try {
		base = new URL(trimmed)
	} catch {
		// baseUrl 不合法就放弃重定基，宁可按录制时的 URL 跑，也不要拼出怪 URL
		return url
	}

	let target: URL
	try {
		target = new URL(url)
	} catch {
		// 相对 URL（frame 的 urlPattern 可能是 `/inner-form`）：按 baseUrl 解析
		try {
			return new URL(url, trimmed).toString()
		} catch {
			return url
		}
	}

	return `${base.origin}${target.pathname}${target.search}${target.hash}`
}

/** 只换 origin（保持 path/query/hash），便于日志展示差异 */
export function describeRebase(url: string, baseUrl?: string): string {
	const next = rebaseUrl(url, baseUrl)
	return next === url ? url : `${url} → ${next}`
}

/**
 * URL 是否匹配 pattern（通配），并且做跨环境兜底：
 * 完整 URL 不匹配时再比一次 pathname+search —— 录制在 A 端口、回放在 B 端口时，
 * origin 一定不同，只比路径才是稳的。
 */
export function matchesUrlPattern(
	url: string,
	pattern: string,
	baseUrl?: string,
	toRegExp?: (pattern: string) => RegExp,
): boolean {
	const compile = toRegExp ?? ((p: string) => new RegExp(p))
	const rebased = rebaseUrl(pattern, baseUrl)
	if (compile(rebased).test(url)) return true
	try {
		const patternUrl = new URL(rebased)
		const actual = new URL(url)
		const pathPattern = `${patternUrl.pathname}${patternUrl.search}`
		return compile(pathPattern).test(`${actual.pathname}${actual.search}`)
	} catch {
		return false
	}
}
