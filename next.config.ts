import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    "/*": [".khloei/**/*"],
  },
};

export default nextConfig;
