import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingExcludes: {
    // `/**` covers every application route without matching Next's internal
    // `next-server` trace. A global `*` matcher can over-apply ignore globs to
    // framework paths such as next/dist/lib/metadata on Next 15 standalone.
    '/**': [
      './.omo/**/*',
      './data/**/*',
      './dist-electron/**/*',
      './迭代文档/**/*',
      './test/**/*',
      './e2e/**/*',
      './playwright-report/**/*',
      './test-results/**/*',
      './FSBP_Test/**/*',
    ],
  },
};

export default nextConfig;
