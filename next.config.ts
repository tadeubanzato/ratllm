import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  // The page was called Benchmarks; old links and bookmarks keep working.
  async redirects() { return [{ source: "/benchmarks", destination: "/performance", permanent: true }]; },
};

export default nextConfig;
