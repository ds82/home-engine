import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The core is backend-neutral: it talks to backends only through the adapter interface.
    files: ["packages/engine/src/core/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters", "**/adapters/**"],
              message:
                "core must not import from adapters; depend on the adapter interface instead.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
