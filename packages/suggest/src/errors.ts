/** 建议/应用过程中的可预期错误（Studio 转成 400 + 中文原因） */
export type SuggestErrorCode =
	| 'INVALID_NAME'
	| 'NAME_CONFLICT'
	| 'STEP_NOT_FOUND'
	| 'UNSUPPORTED_STEP'
	| 'VALUE_ALREADY_TEMPLATED'
	| 'EMPTY_VALUE'

export class SuggestError extends Error {
	readonly code: SuggestErrorCode
	constructor(code: SuggestErrorCode, message: string) {
		super(message)
		this.name = 'SuggestError'
		this.code = code
	}
}
