---
"@kuralle-agents/core": major
---

Remove the misnamed `@kuralle-agents/core/hooks` subpath and export its services from the package root instead.

The `./hooks` barrel exported `TracingService`, `MetricsService`, and `InMemoryMetricsService` — three services, no hooks. It was collateral from removing `HarnessHooks`: the directory's real contents were deleted and the barrel was left pointing at the two service re-exports that happened to live there. The live `Hooks` interface was never behind `./hooks`; it reaches users through the package root, where it remains.

Measured before removal: zero consumers of `@kuralle-agents/core/hooks` across `packages/`, `apps/`, `examples-deploy/`, `docs/`, and `apps.docs/`, and zero consumers of the three services through that subpath.

**Migration** — the three services move from the subpath to the root; the `Hooks` type is unchanged.

Before:
```ts
import { TracingService } from '@kuralle-agents/core/hooks';
import { MetricsService, InMemoryMetricsService } from '@kuralle-agents/core/hooks';
```

After:
```ts
import { TracingService } from '@kuralle-agents/core';
import { MetricsService, InMemoryMetricsService } from '@kuralle-agents/core';
```

Added `packages/core/test/exports-map.test.ts` — a permanent guard that dynamically imports every subpath declared in the `exports` map against the built `dist`, so an entry can never again silently point at the wrong (or a missing) file.
