# @kuralle-agents/http-client

Generic HTTP client with exponential-backoff retry, token-bucket rate limiting, and pluggable error classification.

## Install

```bash
npm install @kuralle-agents/http-client
```

No peers required.

## What it does

`HttpClient` wraps `fetch` with configurable retry and rate-limit primitives. Useful for building REST adapter tools in Kuralle agents.

**Key exports:**

- **`HttpClient`** — fetch wrapper with retry, rate limiting, and pluggable error classification.
- **`RetryQueue`** — standalone retry primitive with exponential backoff.
- **`RateLimiter`** — standalone token-bucket rate limiter.
- **`DefaultHttpClassifier`** — built-in error classifier (non-2xx → `HttpError`).
- **`HttpError`** — typed error with `status` and `retryable` fields.

## Usage

```ts
import { HttpClient } from '@kuralle-agents/http-client';

const client = new HttpClient({
  baseUrl: 'https://api.example.com/v1',
  defaultHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
  retry: { maxRetries: 3 },
  rateLimiter: { maxConcurrent: 20, perSecondLimit: 40 },
});

const user = await client.get<User>('users/42');
const result = await client.post<Order>('orders', { body: JSON.stringify(payload) });
```

## Pluggable error classification

`DefaultHttpClassifier` ships as the fallback. Provide your own for domain-specific retry logic:

```ts
import type { ErrorClassifier } from '@kuralle-agents/http-client';

class DomainClassifier implements ErrorClassifier {
  classify({ status, body }: { status: number; body: unknown }) {
    const err = new DomainError(status, body);
    err.retryable = status === 429 || status >= 500;
    err.retryAfterMs = status === 429 ? 5_000 : undefined;
    return err;
  }
}

const client = new HttpClient({
  baseUrl: 'https://api.example.com',
  classifier: new DomainClassifier(),
});
```

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — `createHttpTool` wires an HTTP endpoint as an agent tool.
