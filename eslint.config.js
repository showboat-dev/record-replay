import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
	{ ignores: ['node_modules/**', 'artifacts/**', 'fixtures/site/public/**', 'fixtures/site/alt/**'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-empty': ['error', { allowEmptyCatch: true }],
		},
	},
]
