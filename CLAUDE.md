# The Cockpit That Drives AI

## Development

- **Dev Server Port**: 3456 (run `npm run dev`)
- **Tech Stack**: Next.js 16, React, TypeScript, TailwindCSS

## UI Layout

- **Three-panel swipe mode**: Uses `SwipeableViewContainer` (translateX) to place three panels side by side, with left/right swipe to switch:
  - Panel 1 **Agent** (Chat)
  - Panel 2 **Explorer** (File browser)
  - Panel 3 **Console** (Terminal + browser bubbles)
- **All three panels are always rendered simultaneously**; switching panels is just a CSS transform translation — components are never unmounted/remounted
- **UI component considerations**: When building menus, modals, and floating popovers, be mindful of the three-panel layout:
  - Positioning calculations must account for the boundaries of the current panel
  - z-index levels must be managed consistently
  - Prevent components from overflowing into adjacent panels

## React Performance Conventions

All three panels + every open chat tab stay mounted, so one state change (session
switch, WS push, terminal tick) re-renders large sibling subtrees. Props to a
`memo`'d heavy renderer (chat `MessageBubble`, Explorer previews, Console bubbles)
must be **referentially stable** — one unstable prop silently defeats the `memo`:

- Callbacks → `useCallback`; if a dep churns every render (`fileTree`, live
  `sessionId`), use a ref indirection so the passed-down identity never changes.
- Objects/arrays (e.g. `extra={{…}}`) → `useMemo`. Inside `.map()` extract a
  `memo`'d row (see `ConsoleBubbleRow`) fed stable callbacks + per-item booleans.
- Expensive per-render work → `useMemo([content])`; never parse/format an
  O(document) blob inline in JSX.

## Effect Conventions

All IO / side-effects / dependencies / errors go through the
`Effect<A, E, R>` paradigm. See **`EFFECT.md`** for the full contract:
- Tagged Error types (DBError / WSError / FSError / AgentError / ...)
- Service Tag + Layer.scoped templates for connection pools / subprocesses
- API route / WebSocket handler templates
- React bridging (`useEffectQuery` / `BrowserRuntime.runPromise`)
- `Effect.withSpan` / `CockpitConfig` / Logger conventions
- Server vs Browser bundle boundary rules

When adding any new IO operation (HTTP route, DB query, WS handler,
client-side fetch), **first match a template in EFFECT.md §3-§7**; do not
write raw `fetch` / `try-catch` / `setInterval` in business code.

## Project Structure

Business code lives in `packages/`; `src/` is intentionally minimal
framework boot. See `MODULES.md` for the dependency rules.

- `/src/app/` - Next.js routing only (page.tsx + layout.tsx + one-line
  `route.ts` shims that re-export from feature packages)
- `/src/lib/` - Server bootstrap: `wsServer.ts` (WS server),
  `fileWatcher.ts` (fs watcher)
- `/packages/feature/` - Self-contained domain features:
  - `agent/` - Chat domain (Claude/Ollama/Codex/Kimi/DeepSeek), scheduled
    tasks, slash commands, sidebar panels, tool-call snapshots (shadow git
    per project under `~/.cockpit/snapshots/`, per-call diff viewer)
  - `comments/` - Code annotation API + hooks
  - `console/` - Terminal + browser bubbles + DB bubbles (Postgres / MySQL
    / Redis / Neo4j / MongoDB / Bash / Jupyter)
  - `explorer/` - File browser + code rendering (DiffView, CodeViewer,
    InteractiveMarkdownPreview, PreviewModal) + git + LSP
  - `review/` - Review pages with anchored highlights and threaded comments
  - `skills/` - SKILL.md parser + slash autocomplete + cross-frame bus
  - `workspace/` - Application integrator (Workspace, TabManager,
    Providers, SettingsModal, NoteModal, SessionBrowser)
- `/packages/shared/` - Cross-feature infrastructure:
  - `i18n/` - Translation dictionary + i18next singleton
  - `ui/` - UI primitives (Toast, MarkdownRenderer, Tooltip,
    codeHighlighter, Swipeable*, useViMode, useWebSocket, …)
  - `utils/` - Pure utilities (paths, ollamaEnv, platform, shortId)
- `/chrome-extension/` - Chrome extension (Manifest V3, independent
  sub-project)
- `/bin/` - CLI entry points (`cock.mjs`, `postinstall.mjs`)

## Key Features

- File browser with virtual scrolling and syntax highlighting (Shiki)
- Git status and history integration
- Per-tool-call project snapshots (shadow git per cwd, one commit per
  mutating tool call, 7-day retention; message FileDiff icon opens the
  per-call diff viewer)
- Git blame view
- Code search with Cmd+F (case sensitive / whole word matching)
- ESC key exits blame view first, then closes modal (3s debounce)

## Commands

```bash
npm run dev      # Start dev server on port 3456
npm run build    # Build for production
npm run setup    # Build + npm link
npm run lint     # Run ESLint
cockpit          # Start production server on port 3457 (prefer this — primary entry)
cock             # Same as `cockpit`; prod-only short alias
cockpit-dev      # Start dev server on port 3456 (dev only; no short alias)
cockpit -v       # Show version
```

## npm Publish

Publishing is done via GitHub Actions — **never publish locally with `npm publish`**.

```bash
npm version patch          # Bump version (patch/minor/major)
git push origin main       # Push commit
git push origin v<version> # Push tag → triggers CI publish
```

The `v*` tag push triggers `.github/workflows/publish.yml` which:
1. Builds the project
2. Publishes to npm (`@surething/cockpit`) with provenance
3. Creates a GitHub Release with auto-generated notes

## Project Characteristics

- **Purely local application**: All API request latency is under 10ms
- **No API caching needed**: Local requests are fast enough that caching provides negligible performance gains while introducing data consistency issues

## Claude Code Usage Guidelines

- **Browser testing**: Use `evaluate_script` for DOM manipulation; avoid `take_screenshot` (consumes excessive tokens)
- **Minimize screenshots**: Only take screenshots when visual confirmation is truly needed
- **MCP tools**: Do not use MCP tools unless the user explicitly requests it (e.g., "use xxx")
- **Git commits**: Do not auto-commit code; only commit when the user explicitly says "commit"
- **English everywhere in code**: Write commit messages (subject and body), code comments, and CLI/console log output entirely in English; Chinese may appear only in quoted literals (e.g. UI copy, example prompts). Conversation replies stay in Chinese
