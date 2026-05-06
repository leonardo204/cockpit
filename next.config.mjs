const dev = process.env.COCKPIT_ENV === 'dev';

// Empty stub used to short-circuit Node-only modules from browser bundles.
// `web-tree-sitter` references `fs/promises` inside a `process.versions.node`
// guarded branch that the static analyzer still tries to resolve. Turbopack
// expects a path relative to the project root (the config file's directory);
// absolute filesystem paths are treated as server-relative URLs and rejected.
const EMPTY_STUB = './src/lib/empty-stub.js';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev 和 prod 使用不同输出目录，避免 Turbopack 热更新影响 prod
  distDir: dev ? '.next' : '.next-prod',
  turbopack: {
    // Stub Node built-ins for the BROWSER bundle only. `web-tree-sitter` ships
    // a Node-detection branch full of `await import("fs/promises" | "module" | ...)`
    // calls that the static analyzer tries to resolve, even though they are
    // unreachable at browser runtime. The `browser` condition keeps server
    // code (which legitimately uses these modules) untouched.
    resolveAlias: Object.fromEntries(
      [
        'fs',
        'fs/promises',
        'path',
        'module',
        'os',
        'crypto',
        'stream',
        'child_process',
        'worker_threads',
        'url',
        'tty',
        'util',
      ].flatMap((m) => [
        [m, { browser: EMPTY_STUB }],
        [`node:${m}`, { browser: EMPTY_STUB }],
      ]),
    ),
  },
  // 这些包不让 webpack 打包，运行时从 node_modules 加载
  // claude-agent-sdk: 内部通过 __dirname 定位 cli.js，打包会把路径硬编码为构建机路径
  // node-pty: 原生模块，不能被 webpack 打包
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    'node-pty',
  ],
  // For webpack (used by `next build --webpack`), use the standard fallback
  // mechanism. `false` = "this module is unavailable, drop the import."
  // Mirror the Turbopack list so the two bundlers behave the same.
  webpack(config, { isServer }) {
    if (!isServer) {
      const stubs = ['fs', 'fs/promises', 'path', 'module', 'os', 'crypto', 'stream', 'child_process', 'worker_threads', 'url', 'tty', 'util'];
      const fallback = { ...(config.resolve?.fallback ?? {}) };
      for (const m of stubs) {
        fallback[m] = false;
        fallback[`node:${m}`] = false;
      }
      config.resolve = { ...config.resolve, fallback };
    }
    return config;
  },
};

export default nextConfig;
