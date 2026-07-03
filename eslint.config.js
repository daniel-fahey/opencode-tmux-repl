import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { sonarjs },
    rules: {
      'complexity': ['error', 7],
      'max-depth': ['error', 3],
      'max-lines-per-function': ['error', 30],
      'max-params': ['error', 3],
      'no-empty': 'error',
      'sonarjs/cognitive-complexity': ['error', 10],
      'sonarjs/prefer-immediate-return': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-params': 'off',
      'max-depth': 'off',
      'complexity': 'off',
    },
  },
)
