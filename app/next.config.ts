import type { NextConfig } from "next";

/** Static export: the dapp has no backend of its own and can be served from any static host or IPFS. */
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // lets the export live under a sub-path (e.g. GitHub Pages); empty by default
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
};

export default nextConfig;
