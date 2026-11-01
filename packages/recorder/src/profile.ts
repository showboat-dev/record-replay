/**
 * 登录态（Playwright storageState）读写。
 *
 * 设计约束（见 docs/profiles-rerecord.md §A.2 / §A.5）：
 * 1. **读失败 = 没有登录态**：文件不存在 / 非法 JSON / 形状不对，都只是「这次没带登录态」，
 *    绝不因此让录制失败 —— 用户可能就想录一条未登录的流程。
 * 2. **写要原子**：先写同目录临时文件再 `rename`。录制结束时用户可能刚登录成功，
 *    这时候把已有 profile 覆盖成半截坏数据是最坏的结果（下次录制带着坏 cookie 直接白屏）。
 * 3. **写失败只告警**：profile 是「让下次更省事」的增强，不该影响 flow 落盘。
 * 4. **格式两种都认**：
 *    - 裸 Playwright storageState（`{ cookies, origins }`）—— 任务契约里 `storageStatePath` 的语义；
 *    - Studio profile wrapper（`{ origin, savedAt, storageState }`）—— §A.1 的落盘格式。
 *    读到时记住形状，写回时**保持原形状**，这样 Studio 的 profiles/ 目录不会被 recorder 破坏。
 * 5. profile 含凭证：新文件权限 0600（§A.5）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { BrowserContextOptions } from 'playwright'

/**
 * Playwright 能直接吃的 storageState 结构。
 * 直接复用 Playwright 的类型（`newContext({ storageState })` 的入参），避免两套定义漂移；
 * 运行时只做「cookies/origins 都是数组」的宽校验（`isStorageState`）。
 */
export type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>

/** 磁盘上的两种形状 */
export type ProfileShape = 'raw' | 'wrapped'

export type ProfileStatus = 'disabled' | 'loaded' | 'missing' | 'invalid'

export interface LoadProfileResult {
	status: ProfileStatus
	/** 读完可直接传给 `browser.newContext({ storageState })`；失败时 undefined */
	state?: StorageState
	/** 原文件形状（保存时保持同形状） */
	shape?: ProfileShape
	/** wrapper 里的 origin（保存时回填） */
	origin?: string
	/** 供日志/告警的人话说明（missing / invalid 时才有） */
	message?: string
}

export interface SaveProfileOptions {
	/** 目标形状，默认 'raw'（保持读到的形状由调用方传进来） */
	shape?: ProfileShape
	/** wrapper 形状时的 origin */
	origin?: string
	/** wrapper 形状时的 savedAt，默认当前时间 */
	savedAt?: string
}

export type SaveProfileResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * Playwright storageState 的形状校验（宽进：只要求 cookies/origins 两个数组存在）。
 * 注意：这是**类型断言**式的守卫 —— 元素级字段（name/value/domain…）不深查，
 * 交给 Playwright 自己在 newContext 时报错（比我们重复实现一遍更可靠）。
 */
export function isStorageState(value: unknown): value is StorageState {
	if (!value || typeof value !== 'object') return false
	const candidate = value as { cookies?: unknown; origins?: unknown }
	return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins)
}

/**
 * 读登录态。永远不抛错：任何异常都转成 `status: 'missing' | 'invalid'`。
 * @param path `undefined` / 空串 → `status: 'disabled'`（调用方视为「没配置」）
 */
export async function loadProfile(path: string | undefined | null): Promise<LoadProfileResult> {
	if (!path) return { status: 'disabled' }

	let text: string
	try {
		text = await readFile(path, 'utf8')
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT' || code === 'ENOTDIR')
			return { status: 'missing', message: `登录态文件不存在：${path}` }
		return { status: 'invalid', message: `读取登录态失败（${path}）：${(err as Error).message}` }
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (err) {
		return { status: 'invalid', message: `登录态文件不是合法 JSON（${path}）：${(err as Error).message}` }
	}

	// 1) 裸 storageState
	if (isStorageState(parsed)) return { status: 'loaded', state: parsed, shape: 'raw' }

	// 2) Studio profile wrapper
	const wrapper = parsed as { storageState?: unknown; origin?: unknown } | null
	if (wrapper && typeof wrapper === 'object' && isStorageState(wrapper.storageState)) {
		return {
			status: 'loaded',
			state: wrapper.storageState,
			shape: 'wrapped',
			origin: typeof wrapper.origin === 'string' ? wrapper.origin : undefined,
		}
	}

	return {
		status: 'invalid',
		message: `登录态文件格式不合法（${path}）：既不是 storageState，也不是 {origin,savedAt,storageState} profile`,
	}
}

/**
 * 原子写登录态：`写临时文件 → rename`。
 *
 * 为什么必须原子：录制结束时可能正在覆盖上一次的 profile；如果直接写目标文件，
 * 任何中断（进程被杀/磁盘满）都会留下半个 JSON，下一次录制就会「带着坏 cookie 白屏」。
 * rename 在同一文件系统内是原子的：要么旧文件完整，要么新文件完整。
 *
 * 失败**不抛错**，返回 `{ ok: false, error }`，由调用方记 warning。
 */
export async function saveProfile(
	path: string,
	state: StorageState,
	opts: SaveProfileOptions = {},
): Promise<SaveProfileResult> {
	if (!isStorageState(state)) return { ok: false, error: 'storageState 形状不合法（缺少 cookies/origins）' }

	const shape: ProfileShape = opts.shape ?? 'raw'
	const payload =
		shape === 'wrapped'
			? {
					origin: opts.origin ?? '',
					savedAt: opts.savedAt ?? new Date().toISOString(),
					storageState: state,
				}
			: state

	// 临时文件放同目录（跨目录 rename 可能退化成 copy，失去原子性）
	const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
	try {
		await mkdir(dirname(path), { recursive: true })
		// 含凭证 → 0600（只有当前用户可读写）
		await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
		await rename(tmp, path)
		return { ok: true, path }
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {})
		return { ok: false, error: (err as Error).message }
	}
}

/** 给日志用的一句话摘要（不泄露 cookie 值） */
export function describeStorageState(state: StorageState | undefined): string {
	if (!state) return '无登录态'
	const cookies = state.cookies.length
	const localStorageOrigins = state.origins.filter((origin) => {
		const entry = origin as { origin?: unknown; localStorage?: unknown }
		return Array.isArray(entry?.localStorage) && entry.localStorage.length > 0
	}).length
	return `${cookies} 个 cookie / ${localStorageOrigins} 个含 localStorage 的 origin`
}
