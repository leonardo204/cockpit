// Empty module stub.
//
// Aliased from `next.config.mjs` for Node-only modules (`fs`, `fs/promises`,
// `path`) that get statically referenced from browser-targeted packages but
// only execute on the Node branch (web-tree-sitter does this for fs/promises).
//
// Both Turbopack and Webpack need a concrete module to alias to.
module.exports = {};
