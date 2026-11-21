import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone — a self-contained server with only the traced
  // dependencies, so the Docker image doesn't ship node_modules. See
  // Dockerfile: `public` and `.next/static` are copied in separately, as the
  // standalone output deliberately omits them.
  output: "standalone",
};

export default nextConfig;
