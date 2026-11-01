import { defineConfig } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([
  ...next,
  ...nextTs,
  { settings: { next: { rootDir: "apps/web/" } } },
  { ignores: ["**/dist/**", "**/.next/**", "**/next-env.d.ts"] },
]);
