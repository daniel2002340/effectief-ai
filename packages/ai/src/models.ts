// The only place where model IDs live. Changing a model means re-running the
// eval sets and recalibrating thresholds (see CLAUDE.md, AI/RAG).
export const models = {} as const;
