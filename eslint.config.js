import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig([
  { ignores: ["node_modules/**", "dist/**", "coverage/**", "tmp/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
])
