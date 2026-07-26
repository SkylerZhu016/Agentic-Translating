import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingExcludes: {
    '/*': [
      './.omo/**/*',
      './data/**/*',
      './dist-electron/**/*',
      './迭代文档/**/*',
      './test/**/*',
      './e2e/**/*',
      './playwright-report/**/*',
      './test-results/**/*',
      './experiments/results/**/*',
      './experiments/reports/**/*',
    ],
  },
};

export default nextConfig;
