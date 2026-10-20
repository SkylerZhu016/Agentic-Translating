import type { NextConfig } from "next";

const supportedDistDirs = new Set([
  '.next',
  '.next-web-dev',
  '.next-electron-dev',
])

export function resolveNextDistDir(
  value: string | undefined,
  developmentServer: boolean,
): string {
  if (!developmentServer) return '.next'
  const distDir = value || '.next'
  if (!supportedDistDirs.has(distDir)) {
    throw new Error(`Unsupported AGENTIC_NEXT_DIST_DIR: ${distDir}`)
  }
  return distDir
}

const nextConfig: NextConfig = {
  distDir: resolveNextDistDir(
    process.env.AGENTIC_NEXT_DIST_DIR,
    process.env.AGENTIC_NEXT_DEV_SERVER === '1',
  ),
  output: 'standalone',
  serverExternalPackages: [
    'better-sqlite3',
    'pinyin-pro',
  ],
  // CMU is ESM. Let Webpack compile its lazy require as an internal module;
  // forcing it external makes Next's strict ESM rules reject the sync loader.
  outputFileTracingIncludes: {
    // The pronunciation helper uses createRequire only when a rhyme check is
    // needed. Include these lazy runtime assets in every standalone release.
    '/**': [
      './node_modules/cmu-pronouncing-dictionary/**/*',
      './node_modules/pinyin-pro/**/*',
    ],
  },
  outputFileTracingExcludes: {
    // Best-effort tracing reduction: `/**` covers application routes without
    // matching Next's internal `next-server` trace. Next 15 on Windows can
    // compare backslash-normalized candidates against these POSIX globs, so
    // prepare-standalone.mjs remains the mandatory cross-platform boundary and
    // removes every forbidden top-level tree again before verification.
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
