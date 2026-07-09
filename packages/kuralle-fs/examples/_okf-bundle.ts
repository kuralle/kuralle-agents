/**
 * A conformant OKF v0.1 "sales" knowledge bundle (shared by the OKF examples).
 * Markdown concept files with YAML frontmatter, bundle-relative cross-links, and
 * an index.md for progressive disclosure — exactly the spec's Appendix A shape.
 */
export const SALES_BUNDLE: Record<string, string> = {
  '/index.md': `# Sales knowledge bundle

Start here. Follow links to concepts.

# Datasets
* [Sales](/datasets/sales.md) - all sales-related tables.

# Tables
* [Orders](/tables/orders.md) - one row per completed order.
* [Customers](/tables/customers.md) - one row per customer.
* [Events](/tables/events.md) - raw product event stream.

# Metrics
* [Weekly Active Users](/metrics/weekly_active_users.md) - the WAU definition.
`,

  '/datasets/sales.md': `---
type: BigQuery Dataset
title: Sales
description: All sales-related tables for the retail business.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales
tags: [sales]
timestamp: 2026-05-28T00:00:00Z
---

The sales dataset contains [orders](/tables/orders.md), [customers](/tables/customers.md),
and the raw [events](/tables/events.md) stream that feeds product metrics.
`,

  '/tables/orders.md': `---
type: BigQuery Table
title: Orders
description: One row per completed customer order.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders
tags: [sales, revenue]
timestamp: 2026-05-28T00:00:00Z
---

# Schema
| Column        | Type      | Description                                   |
|---------------|-----------|-----------------------------------------------|
| \`order_id\`    | STRING    | Unique order identifier.                      |
| \`customer_id\` | STRING    | FK to [customers](/tables/customers.md).      |
| \`total_usd\`   | NUMERIC   | Order total in USD.                           |
| \`placed_at\`   | TIMESTAMP | When the order was submitted.                 |

Part of the [sales dataset](/datasets/sales.md).
`,

  '/tables/customers.md': `---
type: BigQuery Table
title: Customers
description: One row per customer.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=customers
tags: [sales]
timestamp: 2026-05-28T00:00:00Z
---

# Schema
| Column        | Type    | Description                    |
|---------------|---------|--------------------------------|
| \`customer_id\` | STRING  | Unique customer identifier.    |
| \`country\`     | STRING  | Billing country.               |
`,

  '/tables/events.md': `---
type: BigQuery Table
title: Events
description: Raw product event stream, one row per user action.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=events
tags: [product, events]
timestamp: 2026-05-28T00:00:00Z
---

# Schema
| Column       | Type      | Description                                  |
|--------------|-----------|----------------------------------------------|
| \`user_id\`    | STRING    | The acting user (join key for activity).     |
| \`event_name\` | STRING    | e.g. \`page_view\`, \`add_to_cart\`.             |
| \`event_ts\`   | TIMESTAMP | When the event occurred.                     |

Feeds the [weekly active users](/metrics/weekly_active_users.md) metric.
`,

  '/metrics/weekly_active_users.md': `---
type: Metric
title: Weekly Active Users (WAU)
description: Count of distinct users with at least one event in a 7-day window.
tags: [product, engagement]
timestamp: 2026-05-28T00:00:00Z
---

# Definition
Weekly Active Users = COUNT(DISTINCT \`user_id\`) over the [events](/tables/events.md)
table, grouped by a trailing 7-day window on \`event_ts\`.

# Examples
\`\`\`sql
SELECT TIMESTAMP_TRUNC(event_ts, WEEK) AS wk, COUNT(DISTINCT user_id) AS wau
FROM sales.events
GROUP BY wk
\`\`\`

The join key for user activity is \`user_id\` on [events](/tables/events.md).
`,
};

/** The correct answer facts the model must recover from the bundle. */
export const EXPECTED = {
  table: 'events',
  joinKey: 'user_id',
  metric: 'distinct',
};
