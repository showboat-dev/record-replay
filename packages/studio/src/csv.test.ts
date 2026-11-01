/**
 * csv.ts 单测（纯函数，无文件/网络依赖）。
 * 契约：docs/batch-run.md §A。
 */
import { describe, expect, it } from 'vitest'

import {
	CsvError,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_ROWS,
	parseCsv,
	type CsvErrorCode,
	type ParsedCsv,
} from './csv.js'

function errorOf(fn: () => unknown): CsvError {
	try {
		fn()
	} catch (error) {
		if (error instanceof CsvError) return error
		throw error
	}
	throw new Error('预期抛出 CsvError，但没有抛错')
}

function codeOf(fn: () => unknown): CsvErrorCode {
	return errorOf(fn).code
}

function textOfError(fn: () => unknown): string {
	return errorOf(fn).message
}

function csv(text: string, opts?: { maxRows?: number; maxBytes?: number }): ParsedCsv {
	return parseCsv(text, opts)
}

describe('parseCsv —— 基础解析', () => {
	it('逗号 + LF：表头与行对齐', () => {
		const result = csv('name,email\n张三,a@b.com\n李四,c@d.com')

		expect(result.headers).toEqual(['name', 'email'])
		expect(result.rows).toEqual([
			{ name: '张三', email: 'a@b.com' },
			{ name: '李四', email: 'c@d.com' },
		])
		expect(result.warnings).toEqual([])
	})

	it.each([
		['LF', 'a,b\n1,2\n'],
		['CRLF', 'a,b\r\n1,2\r\n'],
		['CR（老式 Mac）', 'a,b\r1,2\r'],
	])('%s 行结尾都能解析', (_name, text) => {
		expect(csv(text).rows).toEqual([{ a: '1', b: '2' }])
	})

	it('去掉 UTF-8 BOM（BOM + CRLF）', () => {
		const result = csv('\uFEFFname,age\r\n张三,20\r\n')

		expect(result.headers).toEqual(['name', 'age'])
		expect(result.rows).toEqual([{ name: '张三', age: '20' }])
	})

	it('表头 trim，数据值原样保留（不 trim）', () => {
		const result = csv(' name , email \n 张三 , a@b.com ')

		expect(result.headers).toEqual(['name', 'email'])
		expect(result.rows).toEqual([{ name: ' 张三 ', email: ' a@b.com ' }])
	})

	it('中文表头 + 中文内容', () => {
		const result = csv('姓名,城市\n张三,上海\n李四,北京')

		expect(result.headers).toEqual(['姓名', '城市'])
		expect(result.rows).toEqual([
			{ 姓名: '张三', 城市: '上海' },
			{ 姓名: '李四', 城市: '北京' },
		])
	})

	it('单列 CSV（无分隔符也能解析，默认逗号）', () => {
		const result = csv('email\na@b.com\nc@d.com')

		expect(result.headers).toEqual(['email'])
		expect(result.rows).toEqual([{ email: 'a@b.com' }, { email: 'c@d.com' }])
	})

	it('只有表头、0 行数据 → rows 为空、不报错', () => {
		const result = csv('a,b\n')
		expect(result.headers).toEqual(['a', 'b'])
		expect(result.rows).toEqual([])
	})

	it('没有尾随换行也能收下最后一行', () => {
		expect(csv('a,b\n1,2').rows).toEqual([{ a: '1', b: '2' }])
	})
})

describe('parseCsv —— 引号字段', () => {
	it('引号字段内的逗号不被切分', () => {
		const result = csv('a,b\n"x,y",z')
		expect(result.rows).toEqual([{ a: 'x,y', b: 'z' }])
	})

	it('"" 转义为一个双引号', () => {
		const result = csv('a,b\n1,"say ""hi"""')
		expect(result.rows).toEqual([{ a: '1', b: 'say "hi"' }])
	})

	it('引号字段内的换行保留（LF）', () => {
		const result = csv('a,b\n"line1\nline2",z')
		expect(result.rows).toEqual([{ a: 'line1\nline2', b: 'z' }])
	})

	it('引号字段内的 CRLF 归一化为 \\n', () => {
		const result = csv('a,b\r\n"line1\r\nline2",z')
		expect(result.rows).toEqual([{ a: 'line1\nline2', b: 'z' }])
	})

	it('分号文件里，引号内的分号不切分', () => {
		const result = csv('a;b\n"x;y";z')
		expect(result.rows).toEqual([{ a: 'x;y', b: 'z' }])
	})

	it('未闭合引号：宽容解析 + 中文 warning（不抛错）', () => {
		const result = csv('a,b\n"oops')

		expect(result.rows).toEqual([{ a: 'oops', b: '' }])
		expect(result.warnings.join('|')).toContain('未闭合')
	})
})

describe('parseCsv —— 分隔符自动识别', () => {
	it('自动识别分号', () => {
		const result = csv('name;email\n张三;a@b.com')
		expect(result.headers).toEqual(['name', 'email'])
		expect(result.rows).toEqual([{ name: '张三', email: 'a@b.com' }])
	})

	it('自动识别制表符', () => {
		const result = csv('a\tb\n1\t2')
		expect(result.headers).toEqual(['a', 'b'])
		expect(result.rows).toEqual([{ a: '1', b: '2' }])
	})

	it('平手默认逗号（分号与逗号各 1 个）', () => {
		const result = csv('a;b,c\n1;2,3')
		expect(result.headers).toEqual(['a;b', 'c'])
		expect(result.rows).toEqual([{ 'a;b': '1;2', c: '3' }])
	})

	it('表头里引号内的分隔符不影响识别', () => {
		const result = csv('"a;b",c\n1,2')
		expect(result.headers).toEqual(['a;b', 'c'])
		expect(result.rows).toEqual([{ 'a;b': '1', c: '2' }])
	})

	it('单列表头（没有任何分隔符）→ 默认逗号、单列', () => {
		const result = csv('only\nvalue')
		expect(result.headers).toEqual(['only'])
		expect(result.rows).toEqual([{ only: 'value' }])
	})
})

describe('parseCsv —— 空行', () => {
	it('跳过中间空行并给 warning', () => {
		const result = csv('a,b\n1,2\n\n3,4')

		expect(result.rows).toEqual([
			{ a: '1', b: '2' },
			{ a: '3', b: '4' },
		])
		expect(result.warnings).toContain('已跳过 1 个空行')
	})

	it('跳过开头空行（表头取第一条非空行）', () => {
		const result = csv('\n\nname,email\n1,a@b.com')

		expect(result.headers).toEqual(['name', 'email'])
		expect(result.warnings).toContain('已跳过 2 个空行')
	})

	it('纯空白行也算空行', () => {
		const result = csv('a,b\n1,2\n   \n3,4')
		expect(result.rows).toHaveLength(2)
		expect(result.warnings.join('|')).toContain('已跳过 1 个空行')
	})

	it('`""` 不算空行，是「有值的空字符串」', () => {
		const result = csv('a\n""\n')
		expect(result.rows).toEqual([{ a: '' }])
		expect(result.warnings).toEqual([])
	})

	it('空行不影响数据行号（第 2 行数据仍然是从 1 数）', () => {
		const result = csv('a,b\n1,2\n\n3')
		expect(result.warnings.join('|')).toContain('第 2 行数据只有 1 列')
	})
})

describe('parseCsv —— 列数不齐', () => {
	it('缺列补空 + warning（不抛错）', () => {
		const result = csv('a,b,c\n1,2')

		expect(result.rows).toEqual([{ a: '1', b: '2', c: '' }])
		expect(result.warnings.join('|')).toContain('只有 2 列')
		expect(result.warnings.join('|')).toContain('缺列已补空')
	})

	it('多余列忽略 + warning（不抛错）', () => {
		const result = csv('a,b\n1,2,3')

		expect(result.rows).toEqual([{ a: '1', b: '2' }])
		expect(result.warnings.join('|')).toContain('有 3 列')
		expect(result.warnings.join('|')).toContain('多余列已忽略')
	})

	it('多行不齐 → 每行一条 warning', () => {
		const result = csv('a,b\n1\n2,3,4')
		const joined = result.warnings.join('|')
		expect(joined).toContain('第 1 行数据')
		expect(joined).toContain('第 2 行数据')
	})
})

describe('parseCsv —— 表头 trim / 重名 / 空列名', () => {
	it('重名列自动 _2/_3', () => {
		const result = csv('name,name,name\n1,2,3')

		expect(result.headers).toEqual(['name', 'name_2', 'name_3'])
		expect(result.warnings.join('|')).toContain('重名')
	})

	it('生成名与真实列名冲突时继续去重（a / a_2 / a_2_2）', () => {
		const result = csv('a,a,a_2\n1,2,3')
		expect(result.headers).toEqual(['a', 'a_2', 'a_2_2'])
	})

	it('大小写不同视为不同列（只 trim，不改大小写）', () => {
		const result = csv('Name,name\n1,2')
		expect(result.headers).toEqual(['Name', 'name'])
	})

	it('空列名兜底 column_N + warning', () => {
		const result = csv('a, ,c\n1,2,3')

		expect(result.headers).toEqual(['a', 'column_2', 'c'])
		expect(result.warnings.join('|')).toContain('column_2')
	})

	it('表头全为空（",,"）→ EMPTY_HEADER', () => {
		expect(codeOf(() => csv(',,'))).toBe('EMPTY_HEADER')
		expect(textOfError(() => csv(',,'))).toContain('表头')
	})
})

describe('parseCsv —— 限额与错误', () => {
	it('默认上限常量：2000 行 / 5MB', () => {
		expect(DEFAULT_MAX_ROWS).toBe(2000)
		expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024)
	})

	it('默认 2000 行可以解析，2001 行抛 TOO_MANY_ROWS', () => {
		const make = (n: number): string =>
			`a\n${Array.from({ length: n }, (_, index) => `v${index}`).join('\n')}`

		expect(csv(make(2000)).rows).toHaveLength(2000)

		const error = errorOf(() => csv(make(2001)))
		expect(error.code).toBe('TOO_MANY_ROWS')
		expect(error.message).toContain('超过上限 2000 行')
	})

	it('自定义 maxRows 生效', () => {
		expect(csv('a\n1\n2', { maxRows: 2 }).rows).toHaveLength(2)
		expect(codeOf(() => csv('a\n1\n2\n3', { maxRows: 2 }))).toBe('TOO_MANY_ROWS')
	})

	it('超过 maxBytes 抛 TOO_LARGE（中文原因）', () => {
		const error = errorOf(() => csv('a,b\n' + 'x'.repeat(100), { maxBytes: 16 }))
		expect(error.code).toBe('TOO_LARGE')
		expect(error.message).toContain('过大')
	})

	it('maxBytes 边界：恰好等于上限可解析，多 1 字节就抛 TOO_LARGE', () => {
		const text = 'a,b\n' + 'x,y'
		expect(() => csv(text, { maxBytes: text.length })).not.toThrow()
		expect(codeOf(() => csv(text, { maxBytes: text.length - 1 }))).toBe('TOO_LARGE')
	})

	it('空文本 → EMPTY_CSV', () => {
		expect(codeOf(() => csv(''))).toBe('EMPTY_CSV')
		expect(textOfError(() => csv(''))).toContain('CSV')
	})

	it('只有空白/空行 → EMPTY_CSV', () => {
		expect(codeOf(() => csv('   \n\n \r\n'))).toBe('EMPTY_CSV')
	})

	it('CsvError 是 Error 子类，带 name/code', () => {
		const error = errorOf(() => csv(''))
		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('CsvError')
		expect(error.code).toBe('EMPTY_CSV')
	})
})

describe('parseCsv —— 纯函数与综合场景', () => {
	it('同一输入多次解析结果一致（纯函数）', () => {
		const text = 'name,email\n张三,a@b.com'
		expect(csv(text)).toEqual(csv(text))
	})

	it('分号 + CRLF + 引号 + 空行 + 列数不齐综合场景', () => {
		const text = [
			'\uFEFF姓名;邮箱;备注',
			'张三;a@b.com;"第一行',
			'第二行"',
			'',
			'李四;c@d.com',
			'王五;e@f.com;多出来的列;忽略我',
		].join('\r\n')

		const result = csv(text)

		expect(result.headers).toEqual(['姓名', '邮箱', '备注'])
		expect(result.rows[0]).toEqual({ 姓名: '张三', 邮箱: 'a@b.com', 备注: '第一行\n第二行' })
		expect(result.rows[1]).toEqual({ 姓名: '李四', 邮箱: 'c@d.com', 备注: '' })
		expect(result.rows[2]).toEqual({ 姓名: '王五', 邮箱: 'e@f.com', 备注: '多出来的列' })
		expect(result.warnings.join('|')).toContain('已跳过 1 个空行')
		expect(result.warnings.join('|')).toContain('多余列已忽略')
	})
})
