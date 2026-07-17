import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@a2a-workbench/client"],
};

export default nextConfig;
