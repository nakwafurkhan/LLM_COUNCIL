import js from "@eslint/js";
import globals from "globals";

/**
 * Flat ESLint config for both workspaces.
 *
 * Deliberately lean: correctness rules, not style. Style is Prettier's job,
 * and a lint run that argues about quotes trains people to ignore it.
 */
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "server/public/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2023 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-unused-vars": [
        "error",
        // Express error handlers need a 4th arg that is never called.
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-console": ["warn", { allow: ["error", "warn"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
      "no-return-await": "error",
      "require-atomic-updates": "off",
    },
  },
  {
    // Client code runs in a browser and uses JSX.
    files: ["client/**/*.{js,jsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
    },
  },
  {
    // Tests may use console freely and reach for test globals.
    files: ["**/tests/**/*.{js,jsx}", "**/e2e/**/*.js", "**/*.test.{js,jsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-console": "off" },
  },
];
