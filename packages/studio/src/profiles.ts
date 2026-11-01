/**
 * 登录态（Playwright storageState）profile 的存取。
 *
 * 设计（见 docs/profiles-rerecord.md §A）：
 * - 一个 origin 一个文件：`<profilesDir>/<originKey>.json`；
 * - 内容直接包 `context.storageState()`，含 cookie + localStorage；
 * - 含登录凭证，只落本地（.gitignore），API 只返回计数不返回原文。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath, sep } from 'node:path'

export interface ProfileMeta {
	originKey: string
	origin: string
	savedAt: string
	cookieCount: number
	localStorageOrigins: number
}

interface ProfileFile extends ProfileMeta {
	storageState: {
		cookies?: unknown[]
		origins?: Array<{ origin: string; localStorage?: unknown[] }>
	}
}

/** URL → origin；非法 URL 返回 null */
export function originOf(url: string): string | null {
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

/** origin → 安全文件名（host_port + origin 的短 hash，避免大小写/端口/协议碰撞） */
export function originKeyOf(origin: string): string {
	let host = 'site'
	let port = ''
	try {
		const u = new URL(origin)
		host = u.hostname || 'site'
		port = u.port
	} catch {
		/* 非法 origin 也给出兜底名 */
	}
	const slug =
		`${host}${port ? `_${port}` : ''}`
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'site'
	const hash = createHash('sha1').update(origin).digest('hex').slice(0, 8)
	return `${slug}-${hash}`
}

export function profilePathFor(profilesDir: string, origin: string): string {
	return join(profilesDir, `${originKeyOf(origin)}.json`)
}

function normalizeProfileFile(raw: unknown): ProfileFile | null {
	if (typeof raw !== 'object' || raw === null) return null
	const value = raw as Record<string, unknown>
	const state = value.storageState
	if (typeof state !== 'object' || state === null) return null
	const cookies = Array.isArray((state as { cookies?: unknown }).cookies)
		? (state as { cookies: unknown[] }).cookies
		: []
	const origins = Array.isArray((state as { origins?: unknown }).origins)
		? (state as { origins: unknown[] }).origins
		: []
	const savedAt = typeof value.savedAt === 'string' ? value.savedAt : new Date(0).toISOString()
	const origin = typeof value.origin === 'string' ? value.origin : ''
	return {
		originKey: originKeyOf(origin),
		origin,
		savedAt,
		cookieCount: cookies.length,
		localStorageOrigins: origins.length,
		storageState: { cookies, origins: origins as ProfileFile['storageState']['origins'] },
	}
}

/** 读单个 profile 元信息（文件不存在/损坏 → null） */
export async function readProfileMeta(
	profilesDir: string,
	origin: string,
): Promise<ProfileMeta | null> {
	try {
		const text = await readFile(profilePathFor(profilesDir, origin), 'utf8')
		const parsed = normalizeProfileFile(JSON.parse(text))
		if (!parsed) return null
		return {
			originKey: parsed.originKey,
			origin: parsed.origin,
			savedAt: parsed.savedAt,
			cookieCount: parsed.cookieCount,
			localStorageOrigins: parsed.localStorageOrigins,
		}
	} catch {
		return null
	}
}

/** 列出全部 profile（坏文件跳过） */
export async function listProfiles(profilesDir: string): Promise<ProfileMeta[]> {
	let files: string[]
	try {
		files = await readdir(profilesDir)
	} catch {
		return []
	}
	const out: ProfileMeta[] = []
	for (const file of files) {
		if (!file.endsWith('.json')) continue
		try {
			const parsed = normalizeProfileFile(
				JSON.parse(await readFile(join(profilesDir, file), 'utf8')),
			)
			if (!parsed) continue
			out.push({
				originKey: parsed.originKey,
				origin: parsed.origin,
				savedAt: parsed.savedAt,
				cookieCount: parsed.cookieCount,
				localStorageOrigins: parsed.localStorageOrigins,
			})
		} catch {
			/* 坏文件跳过 */
		}
	}
	return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** 该 origin 有可用登录态时返回文件路径（供 recorder/executor 读） */
export async function storageStatePathIfExists(
	profilesDir: string,
	origin: string | null,
): Promise<string | null> {
	if (!origin) return null
	const path = profilePathFor(profilesDir, origin)
	const meta = await readProfileMeta(profilesDir, origin)
	return meta ? path : null
}

/** 原子写：先写临时文件再 rename（避免写坏已有 profile） */
export async function writeProfile(
	profilesDir: string,
	origin: string,
	storageState: unknown,
): Promise<ProfileMeta> {
	const path = profilePathFor(profilesDir, origin)
	const { mkdir } = await import('node:fs/promises')
	await mkdir(profilesDir, { recursive: true })
	const payload: ProfileFile = {
		originKey: originKeyOf(origin),
		origin,
		savedAt: new Date().toISOString(),
		cookieCount: Array.isArray((storageState as { cookies?: unknown[] })?.cookies)
			? (storageState as { cookies: unknown[] }).cookies.length
			: 0,
		localStorageOrigins: Array.isArray((storageState as { origins?: unknown[] })?.origins)
			? (storageState as { origins: unknown[] }).origins.length
			: 0,
		storageState: storageState as ProfileFile['storageState'],
	}
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
	await rename(tmp, path)
	return {
		originKey: payload.originKey,
		origin: payload.origin,
		savedAt: payload.savedAt,
		cookieCount: payload.cookieCount,
		localStorageOrigins: payload.localStorageOrigins,
	}
}

/** 删除 profile（只允许删除 profilesDir 下的 .json，路径安全校验） */
export async function deleteProfile(profilesDir: string, originKey: string): Promise<boolean> {
	if (!/^[a-z0-9._-]+$/.test(originKey)) return false
	const dir = resolvePath(profilesDir)
	const target = resolvePath(join(dir, `${originKey}.json`))
	if (!target.startsWith(`${dir}${sep}`)) return false
	try {
		await rm(target)
		return true
	} catch {
		return false
	}
}
