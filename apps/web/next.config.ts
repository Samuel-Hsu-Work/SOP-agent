import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sop-core is consumed from TypeScript source, so Next has to compile it.
  transpilePackages: ["@sop-agent/sop-core"],
};

export default nextConfig;
