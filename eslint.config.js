import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['src/server/**/*.ts', 'src/shared/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // The client. `react-hooks` is the half that earns its place: the rules of hooks are
    // not checkable by the type system, and a conditional hook is a bug that shows up as a
    // component that renders correctly until the day it does not.
    files: ['src/client/**/*.ts', 'src/client/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@typescript-eslint': tseslint, react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      // The JSX transform is automatic, so React does not have to be in scope.
      'react/react-in-jsx-scope': 'off',
      'react/jsx-key': 'error',
      // `dangerouslySetInnerHTML` is how attacker-influenced content — an audit row's
      // metadata, a project name, a file path — reaches something that interprets markup.
      // There is no use for it in this panel and an error is cheaper than a review.
      'react/no-danger': 'error',
    },
  },
];
