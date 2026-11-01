/**
 * naming.ts 单测（表驱动）：中文词表 → ASCII、英文 snake_case、兜底、查重、类型推断。
 * 规则出处：docs/parameterization.md §4。
 */
import { describe, expect, it } from 'vitest'

import { deriveVariableName, deriveVariableType, makeUniqueName } from './naming.js'

describe('deriveVariableName —— 中文词表 → ASCII', () => {
	it.each([
		['姓名', 'name'],
		['用户名', 'username'],
		['邮箱', 'email'],
		['邮件地址', 'email'],
		['手机', 'phone'],
		['电话号码', 'phone'],
		['地址', 'address'],
		['报销金额', 'amount'],
		['价格', 'amount'],
		['数量', 'quantity'],
		['订单号', 'order_no'],
		['单号', 'order_no'],
		['编号', 'code'],
		['身份证', 'id_number'],
		['日期', 'date'],
		['账号', 'account'],
		['公司', 'company'],
		['客户名称', 'customer'],
		['城市', 'city'],
		['国家', 'country'],
		['备注', 'remark'],
		['简介', 'bio'],
	])('%s → %s', (label, expected) => {
		expect(deriveVariableName({ label, stepIndex: 0 })).toBe(expected)
	})

	it('长词优先：「订单号」不会被「单号」抢先', () => {
		expect(deriveVariableName({ label: '订单号', stepIndex: 0 })).toBe('order_no')
	})

	it('中文里夹英文也可命中词表', () => {
		expect(deriveVariableName({ label: '邮箱 Email', stepIndex: 0 })).toBe('email')
	})
})

describe('deriveVariableName —— 英文 label → snake_case', () => {
	it.each([
		['Email Address', 'email_address'],
		['First Name', 'first_name'],
		['e-mail', 'e_mail'],
		['  Order No.  ', 'order_no'],
		['Company Name', 'company_name'],
	])('%s → %s', (label, expected) => {
		expect(deriveVariableName({ label, stepIndex: 0 })).toBe(expected)
	})
})

describe('deriveVariableName —— 优先级与兜底', () => {
	it('label > placeholder > nameAttr', () => {
		expect(
			deriveVariableName({
				label: '邮箱',
				placeholder: 'phone',
				nameAttr: 'username',
				stepIndex: 0,
			}),
		).toBe('email')
	})

	it('label 为空时用 placeholder', () => {
		expect(deriveVariableName({ label: '', placeholder: '电话', stepIndex: 0 })).toBe('phone')
	})

	it.each([
		[{ stepIndex: 0 }, 'field_1'],
		[{ stepIndex: 4 }, 'field_5'],
		[{ label: '会员卡号', stepIndex: 0 }, 'field_1'], // 中文但不在词表
		[{ label: '2026 report', stepIndex: 2 }, 'field_3'], // snake 后以数字开头，非法
		[{ label: '!!!', stepIndex: 1 }, 'field_2'], // 全被剔除
	])('%j → %s（兜底 field_<stepIndex+1>）', (input, expected) => {
		expect(deriveVariableName(input as Parameters<typeof deriveVariableName>[0])).toBe(expected)
	})
})

describe('makeUniqueName', () => {
	it('未占用时原样返回', () => {
		expect(makeUniqueName('email', new Set())).toBe('email')
	})

	it('被占用时追加 _2', () => {
		expect(makeUniqueName('email', new Set(['email']))).toBe('email_2')
	})

	it('_2 也被占用时继续 _3', () => {
		expect(makeUniqueName('email', new Set(['email', 'email_2']))).toBe('email_3')
	})

	it('非法/空 base 退化为 field 再查重', () => {
		expect(makeUniqueName('', new Set())).toBe('field')
		expect(makeUniqueName('1abc', new Set())).toBe('field')
		expect(makeUniqueName('1abc', new Set(['field']))).toBe('field_2')
	})
})

describe('deriveVariableType —— 类型推断', () => {
	it.each([
		[{ inputType: 'email', stepIndex: 0 }, 'email'],
		[{ inputType: 'tel', stepIndex: 0 }, 'email'], // §4：email/tel → email
		[{ inputType: 'date', stepIndex: 0 }, 'date'],
		[{ inputType: 'number', stepIndex: 0 }, 'number'],
		[{ inputType: 'textarea', stepIndex: 0 }, 'text'],
		[{ label: '金额', stepIndex: 0 }, 'number'],
		[{ label: '购买数量', stepIndex: 0 }, 'number'],
		[{ label: '日期', stepIndex: 0 }, 'date'],
		[{ label: '邮箱', stepIndex: 0 }, 'email'],
		[{ label: '备注', stepIndex: 0 }, 'text'],
		[{ label: '简介', stepIndex: 0 }, 'text'],
		[{ label: 'Note', stepIndex: 0 }, 'text'],
		[{ label: 'Your Name', stepIndex: 0 }, 'string'],
		[{ label: '城市', stepIndex: 0 }, 'string'],
		[{ stepIndex: 0 }, 'string'],
	] as const)('%j → %s', (input, expected) => {
		expect(deriveVariableType({ ...input })).toBe(expected)
	})
})
