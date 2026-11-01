/**
 * CSV 解析纯函数（docs/batch-run.md §A）。
 *
 * 设计要点：
 * - 零依赖、纯函数（不读文件、不碰全局状态），供 Studio API 与单测共用；
 * - 单遍状态机词法分析：BOM / CRLF / CR / LF、引号字段（`"a,b"`、`""` 转义、字段内换行）；
 * - 分隔符自动识别：逗号 / 分号 / 制表符，按表头行切出的列数挑（平手默认逗号）；
 * - 跳过完全空行（含纯空白行；`""` 不算空行，是「有值的空字符串」）；
 * - 列数不齐不抛错：缺列补 '' / 多余列忽略，写进 warnings；
 * - 表头 trim + 空列名兜底 column_N + 重名去重 name/name_2/name_3；
 * - 限额：默认 2000 行 / 5MB / 表头至少 1 个非空列名，超出抛 CsvError（中文消息）。
 *
 * 说明：`ParsedCsv.rows` 的 key 是**去重后的表头**；行号按「数据行」1-based 计（不含表头、
 * 不含被跳过的空行），与 docs/batch-run.md 的 BatchRow.index 语义一致。
 */

/** CSV 解析失败的错误码（Studio 可据此映射 400） */
export type CsvErrorCode = 'EMPTY_CSV' | 'EMPTY_HEADER' | 'TOO_MANY_ROWS' | 'TOO_LARGE'

/** 可预期的 CSV 解析错误（带中文原因） */
export class CsvError extends Error {
	readonly code: CsvErrorCode

	constructor(code: CsvErrorCode, message: string) {
		super(message)
		this.name = 'CsvError'
		this.code = code
	}
}

export interface ParsedCsv {
	/** trim 后；重名列自动 _2/_3；空列名兜底 column_N */
	headers: string[]
	/** 按 headers 对齐；缺列补 ''；多余列忽略 */
	rows: Array<Record<string, string>>
	/** 列数不齐 / 空行跳过 / 表头重命名等提示（中文，UI 直接展示） */
	warnings: string[]
}

export interface ParseCsvOptions {
	/** 数据行上限（不含表头），默认 2000 */
	maxRows?: number
	/** 文本字节上限（UTF-8），默认 5MB */
	maxBytes?: number
}

export const DEFAULT_MAX_ROWS = 2000
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/** 候选分隔符；顺序即平手时的优先级（comma 在最前 = 默认） */
const DELIMITER_CANDIDATES = [',', ';', '\t'] as const

interface TokenizedCsv {
	/** 已剔除空行；每项是一行的字段数组 */
	records: string[][]
	/** 被跳过的空行数量 */
	blankLines: number
	/** 是否遇到未闭合的引号（已宽容解析） */
	unclosedQuote: boolean
}

/**
 * 判断「完全空行」：只有一个字段、没有出现过引号、且 trim 后为空。
 * `""` 会因出现过引号而被保留为「有值的空字符串」。
 */
function isBlankRecord(fields: string[], hadQuote: boolean): boolean {
	return fields.length === 1 && !hadQuote && (fields[0] ?? '').trim() === ''
}

/** 单遍状态机：text → 记录数组（跳过空行） */
function tokenize(text: string, delimiter: string): TokenizedCsv {
	const records: string[][] = []
	let fields: string[] = []
	let field = ''
	let inQuotes = false
	let hadQuote = false
	let hasRecordContent = false
	let blankLines = 0
	let i = 0

	const endRecord = (): void => {
		if (isBlankRecord(fields.length === 0 ? [''] : fields, hadQuote)) {
			blankLines += 1
		} else {
			records.push(fields)
		}
		fields = []
		field = ''
		hadQuote = false
		hasRecordContent = false
	}

	while (i < text.length) {
		const ch = text[i] as string

		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"'
					i += 2
				} else {
					inQuotes = false
					i += 1
				}
				continue
			}
			if (ch === '\r') {
				// 引号内的换行保留语义，统一归一化成 \n
				field += '\n'
				i += text[i + 1] === '\n' ? 2 : 1
				continue
			}
			field += ch
			i += 1
			continue
		}

		if (ch === '"' && field === '') {
			inQuotes = true
			hadQuote = true
			hasRecordContent = true
			i += 1
			continue
		}

		if (ch === delimiter) {
			fields.push(field)
			field = ''
			hasRecordContent = true
			i += 1
			continue
		}

		if (ch === '\r' || ch === '\n') {
			fields.push(field)
			endRecord()
			i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
			continue
		}

		field += ch
		hasRecordContent = true
		i += 1
	}

	// 末尾没有换行：把最后一行收进来（空文件 / 以换行结尾时不产生空记录）
	if (inQuotes) {
		fields.push(field)
		records.push(fields)
		fields = []
		field = ''
	} else if (hasRecordContent || fields.length > 0) {
		fields.push(field)
		endRecord()
	}

	return { records, blankLines, unclosedQuote: inQuotes }
}

/** 只切表头行，用来比较不同分隔符的列数（不整篇 tokenize） */
function headerColumnCount(text: string, delimiter: string): number {
	let count = 1
	let inQuotes = false
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i] as string
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') i += 1
				else inQuotes = false
			}
			continue
		}
		if (ch === '"') {
			inQuotes = true
			continue
		}
		if (ch === delimiter) {
			count += 1
			continue
		}
		if (ch === '\r' || ch === '\n') break
	}
	return count
}

/** 分隔符自动识别：按表头行出现次数（列数）挑，平手默认逗号 */
function detectDelimiter(text: string): string {
	let delimiter: string = DELIMITER_CANDIDATES[0]
	let bestCount = headerColumnCount(text, delimiter)
	for (let index = 1; index < DELIMITER_CANDIDATES.length; index += 1) {
		const candidate = DELIMITER_CANDIDATES[index] as string
		const count = headerColumnCount(text, candidate)
		if (count > bestCount) {
			delimiter = candidate
			bestCount = count
		}
	}
	return delimiter
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
	const normalized = Math.floor(value)
	return normalized > 0 ? normalized : fallback
}

/** 处理表头：trim、空列名兜底 column_N、重名去重 name/_2/_3 */
function buildHeaders(rawHeaders: string[], warnings: string[]): string[] {
	const trimmed = rawHeaders.map((item) => item.trim())
	if (trimmed.every((item) => item === '')) {
		throw new CsvError('EMPTY_HEADER', '表头为空：CSV 第一行必须是列名，且至少有一列非空')
	}

	const headers: string[] = []
	const taken = new Set<string>()
	for (let index = 0; index < trimmed.length; index += 1) {
		let name = trimmed[index] as string
		if (!name) {
			name = `column_${index + 1}`
			warnings.push(`第 ${index + 1} 列表头为空，已命名为 ${name}`)
		}
		let unique = name
		let suffix = 2
		while (taken.has(unique)) {
			unique = `${name}_${suffix}`
			suffix += 1
		}
		if (unique !== name) {
			warnings.push(`表头「${name}」重名，已自动重命名为「${unique}」`)
		}
		taken.add(unique)
		headers.push(unique)
	}
	return headers
}

/**
 * 解析 CSV 文本。纯函数、零依赖；解析失败抛 {@link CsvError}（中文原因）。
 *
 * @example
 * parseCsv('\uFEFFname,email\r\n张三,a@b.com\r\n')
 * // → { headers: ['name','email'], rows: [{ name: '张三', email: 'a@b.com' }], warnings: [] }
 */
export function parseCsv(text: string, opts: ParseCsvOptions = {}): ParsedCsv {
	const maxRows = positiveInteger(opts.maxRows, DEFAULT_MAX_ROWS)
	const maxBytes = positiveInteger(opts.maxBytes, DEFAULT_MAX_BYTES)

	// 1) 字节限额：text.length 是 UTF-16 code unit 数，UTF-8 字节数一定 ≥ 它
	if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
		throw new CsvError(
			'TOO_LARGE',
			`CSV 文件过大：超过 ${maxBytes} 字节上限（约 ${(maxBytes / 1024 / 1024).toFixed(1)}MB），请拆分后再导入`,
		)
	}

	// 2) 去 BOM（只去文件开头的一个）
	const source = text.startsWith('\uFEFF') ? text.slice(1) : text

	// 3) 分隔符识别 + 词法分析
	const delimiter = detectDelimiter(source)
	const tokenized = tokenize(source, delimiter)
	const records = tokenized.records
	if (records.length === 0) {
		throw new CsvError('EMPTY_CSV', 'CSV 内容为空：没有表头，也没有数据行')
	}

	const warnings: string[] = []
	if (tokenized.blankLines > 0) warnings.push(`已跳过 ${tokenized.blankLines} 个空行`)
	if (tokenized.unclosedQuote) warnings.push('存在未闭合的引号，已按原文宽容解析')

	// 4) 表头
	const headers = buildHeaders(records[0] as string[], warnings)

	// 5) 行数限额（只算数据行，不含表头 / 空行）
	const dataRecords = records.slice(1)
	if (dataRecords.length > maxRows) {
		throw new CsvError(
			'TOO_MANY_ROWS',
			`CSV 数据行数 ${dataRecords.length} 超过上限 ${maxRows} 行，请拆分后再导入`,
		)
	}

	// 6) 行对齐：缺列补空、多余列忽略，列数不齐写 warning（不抛错）
	const rows: Array<Record<string, string>> = []
	for (const fields of dataRecords) {
		const rowIndex = rows.length + 1
		if (fields.length < headers.length) {
			warnings.push(
				`第 ${rowIndex} 行数据只有 ${fields.length} 列（表头 ${headers.length} 列），缺列已补空`,
			)
		} else if (fields.length > headers.length) {
			warnings.push(
				`第 ${rowIndex} 行数据有 ${fields.length} 列（表头 ${headers.length} 列），多余列已忽略`,
			)
		}
		const row: Record<string, string> = {}
		for (let index = 0; index < headers.length; index += 1) {
			row[headers[index] as string] = fields[index] ?? ''
		}
		rows.push(row)
	}

	return { headers, rows, warnings }
}
