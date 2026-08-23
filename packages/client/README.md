# @kuralle-agents/client

Pure reducer from indexed `StreamPart` events to a transport-agnostic `TurnView`. Shared by `kuralle` (JSON) and `kuralle-tui` (OpenTUI).

## Install

```bash
npm install @kuralle-agents/client @kuralle-agents/core
```

## Usage

```ts
import { reduce, type LoggedEvent } from '@kuralle-agents/client';

const view = reduce(events);
const resumed = reduce(moreEvents, view);
```
