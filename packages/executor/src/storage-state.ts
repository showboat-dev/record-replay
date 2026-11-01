/**
 * 登录态（browser storageState）的读写 + 登录过期人话提示。
 *
 * 契约见 docs/profiles-rerecord.md §A.2 / §A.4：
 * - 读：`PlayOptions.storageStatePath` → `browser.newContext({ storageState })`；
 *   文件不存在 / JSON 非法 / 结构不对 → **只告警，继续按未登录回放**（不能因为登录态坏了就跑不了流程）；
 * - 写：`PlayOptions.saveStorageStatePath` → 每个 run 结束（无论成败）尽力保存；
 *   **原子写**：先写同目录临时文件再 `rename`，避免中途崩溃留下半个 JSON 把下次回放搞挂；
 * - 登录过期检测是启发式：失败时当前 URL 命中 /login|signin|sign-in|auth|sso|登录/ 就追加一句人话，
 *   只改 `error.message`，**不改 `error.code`**（前端按 message 里是否含该提示决定显示「更新登录态」按钮）。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserContext } from 'playwright'

/** Playwright 的 storageState 返回类型（不依赖其内部类型导出） */
export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>

/**
 * 结构校验：`{ cookies: [...], origins?: [...] }`。
 * 只做"能安全交给 Playwright"的最低限度检查 —— 太严格会把 Playwright 未来新增字段的新版本挡掉。
 */
export function parseStorageState(raw: unknown): BrowserStorageState | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
	const record = raw as Record<string, unknown>
	if (!Array.isArray(record.cookies)) return undefined
	if (record.origins !== undefined && !Array.isArray(record.origins)) return undefined
	// Playwright 的 StorageState 要求 origins 必填，缺省补空数组
	return {
		cookies: record.cookies as BrowserStorageState['cookies'],
		origins: (record.origins as BrowserStorageState['origins'] | undefined) ?? [],
	}
}

/**
 * 读取 storageState 文件。任何失败都返回 undefined（调用方按"未登录"继续），
 * 只在日志里说明原因，绝不抛错。
 */
export async function loadStorageState(
	path: string | undefined,
	log: (msg: string) => void = () => {},
): Promise<BrowserStorageState | undefined> {
	if (!path || path.trim() === '') return undefined
	let text: string
	try {
		text = await readFile(path, 'utf8')
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		log(
			code === 'ENOENT'
				? `登录态文件不存在，按未登录回放：${path}`
				: `登录态文件读取失败，按未登录回放：${path}（${(err as Error).message}）`,
		)
		return undefined
	}
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		log(`登录态文件不是合法 JSON，按未登录回放：${path}`)
		return undefined
	}
	const state = parseStorageState(raw)
	if (!state) {
		log(`登录态文件结构不合法（缺少 cookies 数组），按未登录回放：${path}`)
		return undefined
	}
	return state
}

/**
 * 原子写：临时文件 + rename（同一目录内 rename 是原子替换）。
 * 失败只告警并返回 false —— 保存登录态失败绝对不能影响回放结果。
 */
export async function saveStorageStateAtomic(
	path: string,
	state: BrowserStorageState,
	log: (msg: string) => void = () => {},
): Promise<boolean> {
	const tempPath = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`
	try {
		await mkdir(dirname(path), { recursive: true })
		// 0o600：cookie 等同凭证，只给当前用户读
		await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		})
		await rename(tempPath, path)
		return true
	} catch (err) {
		log(`保存登录态失败（不影响回放结果）：${path}（${(err as Error).message}）`)
		await unlink(tempPath).catch(() => undefined)
		return false
	}
}

/** 从仍然存活的 context 抓当前登录态并原子写回 */
export async function saveContextStorageState(
	context: BrowserContext,
	path: string | undefined,
	log: (msg: string) => void = () => {},
): Promise<boolean> {
	if (!path || path.trim() === '') return false
	try {
		const state = await context.storageState()
		return await saveStorageStateAtomic(path, state, log)
	} catch (err) {
		log(`读取浏览器登录态失败（不影响回放结果）：${(err as Error).message}`)
		return false
	}
}

/** 登录页启发式（docs/profiles-rerecord.md §A.4 原文给的模式） */
const LOGIN_URL_RE = /login|signin|sign-in|auth|sso|登录/i

/** 追加到失败信息末尾的人话提示（前端靠 includes 判断是否展示「更新登录态」按钮） */
export const LOGIN_EXPIRED_HINT = '登录状态可能已过期，请在 Studio 里点『更新登录态』重新登录一次'

/** 当前 URL 看起来是不是登录页 */
export function looksLikeLoginUrl(url: string | undefined | null): boolean {
	if (!url) return false
	return LOGIN_URL_RE.test(url)
}

/** 失败信息追加登录提示（幂等：已经带这句就不重复追加） */
export function appendLoginExpiredHint(message: string, url: string | undefined | null): string {
	if (!looksLikeLoginUrl(url)) return message
	if (message.includes(LOGIN_EXPIRED_HINT)) return message
	return `${message} ${LOGIN_EXPIRED_HINT}`
}
