import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // No native browser controls on app surfaces — always themed in-app UI.
      // `no-restricted-globals` only fires on the *global* confirm/alert/prompt,
      // so the local `confirm` from `useConfirm()` (which shadows it) is fine.
      "no-restricted-globals": [
        "error",
        {
          name: "confirm",
          message:
            "Use useConfirm() from @/components/ui instead of the native confirm().",
        },
        {
          name: "alert",
          message: "Use a toast (sonner) instead of the native alert().",
        },
        {
          name: "prompt",
          message:
            "Use QuickForm from @/components/ui instead of the native prompt().",
        },
      ],
      // window.confirm/alert/prompt are fully migrated → hard error.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='window'][property.name='confirm']",
          message:
            "Use useConfirm() from @/components/ui instead of window.confirm().",
        },
        {
          selector:
            "MemberExpression[object.name='window'][property.name='alert']",
          message: "Use a toast (sonner) instead of window.alert().",
        },
        {
          selector:
            "MemberExpression[object.name='window'][property.name='prompt']",
          message:
            "Use QuickForm from @/components/ui instead of window.prompt().",
        },
      ],
      // Native <select> is a large in-progress migration (~64 sites) → warn,
      // so it blocks NEW ones in review without failing CI on the backlog.
      // Escalate to "error" once the remaining sites are converted to Combobox.
      "react/forbid-elements": [
        "warn",
        {
          forbid: [
            {
              element: "select",
              message:
                "No native <select> — use Combobox or Picker from @/components/ui.",
            },
          ],
        },
      ],
    },
  },
];
