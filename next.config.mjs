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
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      const stubs = ['fs', 'fs/promises', 'path', 'module', 'os', 'crypto', 'stream', 'child_process', 'worker_threads', 'url', 'tty', 'util'];
      const fallback = { ...(config.resolve?.fallback ?? {}) };
      for (const m of stubs) {
        fallback[m] = false;
        fallback[`node:${m}`] = false;
      }
      config.resolve = { ...config.resolve, fallback };

      // `web-tree-sitter`'s ESM bundle has a Node-detection branch:
      //
      //   var ENVIRONMENT_IS_NODE = typeof process == "object" &&
      //     process.versions?.node && process.type != "renderer";
      //   if (ENVIRONMENT_IS_NODE) {
      //     const { createRequire } = await import("module");
      //     var require = createRequire(import.meta.url);
      //   }
      //
      // Next.js's webpack browser bundle injects a `process` polyfill that
      // exposes `process.versions.node`, so ENVIRONMENT_IS_NODE evaluates
      // truthy at RUNTIME in the browser — entering the branch, dynamic-
      // importing our `module` stub (which exports `{}`), and crashing on
      // `createRequire(...)` with "createRequire is not a function".
      //
      // Defining `process.versions` to an empty object makes
      // `process.versions.node` AND `process.versions?.node` both
      // evaluate to undefined → ENVIRONMENT_IS_NODE = falsy → if-
      // branch dead-coded out of the browser bundle. (DefinePlugin's
      // handling of `?.` is finicky; overriding the parent expression
      // avoids the question entirely.) `process.type = "renderer"` is
      // a belt-and-suspenders second short-circuit on the same check.
      // Server bundle is untouched (gated on !isServer).
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.DefinePlugin({
          'process.versions': '({})',
          'process.type': '"renderer"',
        }),
      );
    }
    return config;
  },
};

export default nextConfig;
