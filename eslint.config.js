import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // src/sim/ は Three.js と DOM に依存しない（ARC-1）。テストでも確かめるが、編集中に気づけるよう lint でも止める。
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'requestAnimationFrame', 'localStorage'],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'src/sim/ から Three.js を参照しない' },
            // 画面の文言は画面の側で書く（ARC-56）。src/sim/ は識別子と数で返す。
            { group: ['**/ui/i18n', '**/ui/i18n.ts', '**/ui/messages', '**/ui/messages/*'], message: 'src/sim/ から画面の文言の辞書を参照しない' },
          ],
        },
      ],
    },
  },
);
