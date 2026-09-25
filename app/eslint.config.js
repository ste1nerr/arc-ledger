import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const NO_FLOAT_MONEY = [
  { selector: "CallExpression[callee.name='parseFloat']", message: 'Money must stay bigint/decimal strings: no parseFloat.' },
  { selector: "CallExpression[callee.name='Number']", message: 'Money must stay bigint/decimal strings: no Number().' },
  { selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']", message: 'No Number.parseFloat for money.' },
  { selector: "CallExpression[callee.property.name='toFixed']", message: 'No toFixed(): use roundToCents/formatCents.' },
  { selector: "UnaryExpression[operator='+'][argument.type!='Literal']", message: 'No unary + coercion in money code.' },
  { selector: 'Literal[raw=/^\\d*\\.\\d+(e[+-]?\\d+)?$/i]', message: 'No float literals in money code.' },
]

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/money/**', 'src/report/**', 'src/export/**', 'src/chain/**'],
    ignores: ['src/chain/rpc.ts'], // transport pacing only, never touches amounts
    rules: { 'no-restricted-syntax': ['error', ...NO_FLOAT_MONEY] },
  },
)
