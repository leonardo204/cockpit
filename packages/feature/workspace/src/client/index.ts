// @cockpit/feature-workspace — application integrator.
// After the F1-03 chat-first trim the only feature package left to integrate
// is @cockpit/feature-agent; explorer / console / comments / review / skills
// were deleted along with the panels they provided.
//
// Layering rule (2-layer): feature-* → shared-*. Features may import other
// features (acyclic). Shared packages cannot import features. See
// CLAUDE.md / MODULES.md.

// ============================================
// Application shell
// ============================================
export { Workspace } from './Workspace';
export { ProjectSidebar, type ProjectInfo } from './ProjectSidebar';
export { ProjectItem } from './ProjectItem';
export { EmptyState } from './EmptyState';

// ============================================
// Per-project tab orchestrator (mounts the feature-agent chat panel)
// ============================================
export { TabManager } from './TabManager';
export { TabManagerTopBar } from './TabManagerTopBar';
export { TabBar } from './TabBar';
export { useTabState } from './useTabState';

// ============================================
// Application bootstrap providers
// ============================================
export { Providers } from './Providers';
export { I18nProvider } from './I18nProvider';

// ============================================
// Application-level modals
// ============================================
export { SettingsModal } from './SettingsModal';
export { NoteModal } from './NoteModal';
export { NoteToolbar } from './NoteToolbar';
export { SessionBrowser } from './SessionBrowser';
