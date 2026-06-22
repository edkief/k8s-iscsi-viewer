import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle for the container image.
  output: "standalone",
  // @kubernetes/client-node is a server-only dep; keep it external to the bundle.
  serverExternalPackages: ["@kubernetes/client-node"],
};

export default nextConfig;
