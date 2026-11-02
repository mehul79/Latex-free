import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@latex-free/shared"],
  poweredByHeader: false,
};
export default config;
