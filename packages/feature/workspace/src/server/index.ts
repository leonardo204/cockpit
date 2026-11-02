// @cockpit/feature-workspace (server) — application layer server bits.
export * from "./effect/project"
// Pure group rules, shared with the client sidebar so both sides agree on
// what a valid group set is (specs/project-groups.md).
export * from "../client/projectGroups"
// Pure project-name rules, shared with the sidebar for the same reason
// (specs/project-groups.md §8).
export * from "../client/projectTitle"
