import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/generated/**'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { project: false } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // `x ?? 0` on a score/index/rate field is what turned "not measured" into
    // "no problem found" throughout the 28 Jul report: a null severity rendered
    // as 0, banded LOW, and sorted to the bottom of the priority table as though
    // it were the mildest finding. Keep the null and render an explicit reason.
    files: ['src/modules/reports/**/*.ts', 'src/modules/priority/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/__fixtures__/**'],
    rules: {
      // Scoped to score/index/rate identifiers only — `?? 0` on a COUNT is
      // correct (no rows really is zero rows), so banning it outright would
      // train people to disable the rule.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "LogicalExpression[operator='??'][right.value=0][left.property.name=/[Ss]core|[Ii]ndex|[Rr]ate/]",
          message:
            'Do not default a score/index/rate to 0. A null severity means "not measured" — keep it null and render an explicit reason.',
        },
        {
          selector:
            "LogicalExpression[operator='??'][right.value=0][left.name=/[Ss]core|[Ii]ndex|[Rr]ate/]",
          message:
            'Do not default a score/index/rate to 0. A null severity means "not measured" — keep it null and render an explicit reason.',
        },
      ],
    },
  },
);
