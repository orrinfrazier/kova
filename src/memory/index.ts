// Barrel re-export for the per-purpose REST memory clients. Lets callers
// import a single coherent surface even though the modules are split by
// purpose (code / episode / review-feedback / playbook).

export * from './code-rest.js';
export * from './episode-rest.js';
export * from './playbook-rest.js';
export * from './review-feedback-rest.js';
