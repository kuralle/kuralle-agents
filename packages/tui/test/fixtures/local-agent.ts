import { defineAgent } from '@kuralle-agents/core';

/**
 * A local target for `/connect <path>` and `/agent <path>`.
 *
 * It exports an `AgentConfig`, the shape core makes public, so the fixture needs nothing from
 * core's internals. The TUI test previously reached into `packages/cli/test/fixtures` by a relative
 * path — those fixtures import `createTurnHandle` through a deep relative path because it is not
 * exported, and the whole thing resolved only when the cwd happened to be `packages/tui`. It passed
 * under a package-local `bun test` and timed out under the monorepo-wide run.
 *
 * No model: `/connect <path>` resolves and labels the target without taking a turn.
 */
export const agent = defineAgent({
  id: 'local-agent',
  instructions: 'A local target used to prove path resolution.',
});
