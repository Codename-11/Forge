import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: ["out/**", ".next/**", "node_modules/**"] },
  {
    rules: {
      // The runtime/self-host sections render real code snippets as JSX text
      // (forge.toml, mcp.json, install.sh) — the literal quotes are content,
      // not prose, so escaping them would corrupt what's displayed.
      "react/no-unescaped-entities": "off",
      // This is a static-export marketing site built on inline-styled <a>
      // elements; plain anchors are intentional (full-page nav between the
      // three static pages is instant). We don't use next/link here.
      "@next/next/no-html-link-for-pages": "off",
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
