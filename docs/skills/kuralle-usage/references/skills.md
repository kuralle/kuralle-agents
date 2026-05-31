# Skills - Knowledge Base for Agents

## What Are Skills?

**Skills are a knowledge base** - they provide information to the LLM that it can reference when responding to users.

**Skills are NOT executable** - they don't perform actions or modify state. They simply return markdown content that the LLM reads and uses to inform its response.

---

## Skills vs Tools vs Flows

Understanding the difference is critical:

| Aspect | Skills | Tools | Flows |
|--------|--------|-------|-------|
| **What it does** | Returns text/markdown | Executes code, returns data | Orchestrates multi-step process |
| **Who acts** | LLM reads and responds | Tool does something | Runtime manages state |
| **Side effects** | None | DB calls, API requests, etc. | Session state changes |
| **Example** | "Our refund policy is 30 days..." | `{ ticketId: "123" }` | Collect → Verify → Process → Confirm |
| **Use case** | Policies, guidelines, product info | Database lookups, API calls | Structured processes like returns |

---

## How Skills Work

```
┌─────────────────────────────────────────────────────────────────┐
│                    Skill Execution Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  User: "What's your return policy?"                             │
│        │                                                        │
│        ▼                                                        │
│  Agent decides to call skill("return-policy")                   │
│        │                                                        │
│        ▼                                                        │
│  skill tool returns:                                            │
│  ```                                                            │
│  # Return Policy                                               │
│  - 30 days from purchase date                                  │
│  - Original receipt required                                   │
│  - Item must be in resalable condition                         │
│  ```                                                            │
│        │                                                        │
│        ▼                                                        │
│  Tool result added to conversation history                      │
│        │                                                        │
│        ▼                                                        │
│  LLM uses this info to respond:                                 │
│  "Based on our policy, you can return items within 30 days     │
│   if you have the receipt and the item is in new condition."   │
│                                                                 │
│  The SKILL doesn't DO anything. The AGENT does the talking.    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## When to Use Skills

### ✅ Good Skill Use Cases

Skills are ideal for **informational content** that the LLM needs to reference:

```
.kuralle/skill/
├── refund-policy/         # Return/refund guidelines
├── shipping-zones/        # Shipping timeframes by zone
├── product-catalog/       # Product features and pricing
├── escalation-criteria/   # When to escalate issues
└── hours-of-operation/    # Business hours by region
```

**Characteristics of good skills**:
- Content is **informational** (policies, guidelines, facts)
- Retrieved **only when relevant** (user asks about refunds)
- Agent **interprets** and responds in natural language
- No **system action** needed (just talking to user)

### ❌ Bad Skill Use Cases

These should be **Tools** or **Flows** instead:

| ❌ Don't use Skills for | ✅ Use Instead |
|------------------------|----------------|
| "To create a ticket, call API..." | `create_ticket` tool |
| "To check order status, query DB..." | `check_order` tool |
| "To process refund, update fields..." | `process_refund` tool or flow |
| Multi-step approval process | Flow with state management |
| Database queries | Tool with execute function |
| API calls | Tool with execute function |

---

## Procedural Skills: Guiding Agent Behavior

Skills can contain **procedural instructions** that guide the agent on HOW to handle specific scenarios, not just WHAT the policies are.

### What Are Procedural Skills?

**Informational Skills** answer questions:
```markdown
# Shipping Policy
Standard shipping takes 5-7 business days.
Express shipping takes 2-3 business days.
```

**Procedural Skills** guide behavior:
```markdown
# Shipping Inquiry Process

When a customer asks about shipping status:

1. Ask for order number or tracking number
2. Call `check_shipping_status` tool with the number
3. Explain the result clearly to the customer
4. If delayed, apologize and offer options
```

### Spectrum: Informational → Procedural → Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Spectrum of Procedure                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  INFORMATIONAL              PROCEDURAL                 FLOW      │
│  (Pure Knowledge)           (Guided Steps)          (Stateful)  │
│                                                                 │
│  "Shipping takes            "When user asks        (collect     │
│   5-7 days"                  about shipping:          tracking    │
│                              1. Get number          → check     │
│  Skill                       2. Call tool           → explain   │
│                              3. Explain result      → done)     │
│                                                                 │
│  No steps                    LLM interprets         Runtime      │
│  LLM references             suggested order        manages      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Procedural Skills: Pros and Cons

| ✅ Pros | ❌ Cons |
|---------|---------|
| Lightweight - no Flow state needed | No enforcement - LLM may skip steps |
| Composable - multiple skills can interact | No state tracking - if interrupted, can't resume |
| Flexible - LLM adapts to context | Inconsistent execution - varies by model/temperature |
| Quick to author - just markdown | Hard to debug - can't see current step |
| Can guide tool usage | No branching logic - unlike Flows |

### When to Use Each Approach

| Scenario | Best Approach | Why |
|----------|---------------|-----|
| "What's your shipping policy?" | **Informational Skill** | Static information, no process |
| "Where is my order?" (2-3 steps) | **Procedural Skill** OR **Flow** | Simple process, see decision tree below |
| "I want to return my order" (4+ steps) | **Flow** | Needs state tracking, multi-turn |
| "Process my refund" | **Tool** | Direct action |
| Critical business logic | **Flow** | Must execute consistently |

### Decision Tree: Procedural Skill vs Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Procedural Skill vs Flow                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Scenario needs multi-step handling?                            │
│        │                                                        │
│        ├─ NO → Use Informational Skill                          │
│        │                                                        │
│        └─ YES                                                   │
│           │                                                     │
│           ▼                                                     │
│  How many steps?                                               │
│        │                                                        │
│        ├─ 2-3 steps → Consider Procedural Skill                │
│        │                   ┌─────────────────────────┐          │
│        │                   │ PLUS:                  │          │
│        │                   │ • Simple, linear       │          │
│        │                   │ • Low risk if varied    │          │
│        │                   │ • Benefits from LLM     │          │
│        │                   │   flexibility          │          │
│        │                   │                         │          │
│        │                   │ MINUS:                 │          │
│        │                   │ • No enforcement       │          │
│        │                   │ • No state tracking    │          │
│        │                   └─────────────────────────┘          │
│        │                                                        │
│        └─ 4+ steps → Use Flow                                   │
│                   ┌─────────────────────────┐                  │
│                   │ • State management      │                  │
│                   │ • Guaranteed execution  │                  │
│                   │ • Debuggable            │                  │
│                   │ • Branching support     │                  │
│                   └─────────────────────────┘                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Procedural Skill Example: Shipping Inquiry

```markdown
---
name: shipping-inquiry
description: Process for handling shipping status inquiries
---

# Shipping Information

## Delivery Timeframes
- Standard: 5-7 business days
- Express: 2-3 business days
- Overnight: Next business day

## Free Shipping
Free shipping on orders over $50.

---

# Inquiry Process

When handling shipping status inquiries:

1. **Collect tracking information**
   - Ask: "What's your order number or tracking number?"
   - Accept: Order ID (ORDER-XXXXX) or Tracking number (1ZXXX...)

2. **Check status using tool**
   - Call: `check_shipping_status({ orderId })` or `check_shipping_status({ trackingNumber })`

3. **Explain the result clearly**
   - **If in transit**: "Your package is on the way and should arrive by [date]"
   - **If delivered**: "Your package was delivered on [date] to [location]"
   - **If out for delivery**: "Your package is out for delivery today!"

4. **Handle delays with empathy**
   - Acknowledge the delay: "I apologize that your package is delayed."
   - Provide new date: "The updated delivery estimate is [date]."
   - Offer options:
     - "Would you like me to check if expedited shipping is available?"
     - "I can issue a refund for the shipping cost if you'd prefer."
     - "Or you can continue waiting with the updated delivery date."
```

### Procedural Skill vs Flow: Shipping Example

**Procedural Skill approach**:
```markdown
# Shipping Inquiry Process
1. Ask for tracking number
2. Call check_shipping_status tool
3. Explain result
4. If delayed: offer options
```
- ✅ LLM can handle various phrasings naturally
- ✅ Can combine with other skills dynamically
- ❌ No guarantee steps are followed in order
- ❌ Can't resume if interrupted

**Flow approach**:
```jsonc
{
  "flows": {
    "shipping-inquiry-flow": {
      "initialNode": "collect_tracking",
      "nodes": [
        {
          "id": "collect_tracking",
          "prompt": "Ask the customer for their order number or tracking number",
          "transitions": {
            "on_complete": "check_status"
          }
        },
        {
          "id": "check_status",
          "tool": "check_shipping_status",
          "transitions": {
            "on_complete": "explain_status"
          }
        },
        {
          "id": "explain_status",
          "prompt": "Explain the shipping status. If delayed, offer options.",
          "transitions": {
            "on_complete": "done"
          }
        }
      ]
    }
  }
}
```
- ✅ Guaranteed execution order
- ✅ State persisted in session
- ✅ Debuggable (know current node)
- ❌ More complex to author
- ❌ Less flexible to variations

### Enhanced Skill Format: Hybrid

You can combine informational and procedural in one skill:

```markdown
---
name: shipping-complete
description: Shipping policies and inquiry handling process
---

# Shipping Information (Reference)

## Delivery Timeframes
| Zone | Days | Cost |
|------|------|------|
| Standard | 5-7 business days | $4.99 |
| Express | 2-3 business days | $12.99 |

## Tracking
All orders include tracking at example.com/track

---

# Inquiry Process (Instructions)

When a customer asks about shipping status:

1. Collect order number or tracking number
2. Call `check_shipping_status` tool
3. Explain result clearly based on status:
   - In transit: "On the way, ETA [date]"
   - Delivered: "Delivered on [date]"
   - Delayed: Apologize + new date + offer options
```

---

## Skill File Structure

```
.kuralle/
└── skill/
    └── shipping/
        └── SKILL.md
```

### SKILL.md Format

```markdown
---
name: shipping
description: Shipping policies and delivery timeframes
metadata:
  domain: logistics
  category: policies
---

# Shipping Policy

## Delivery Timeframes

| Zone | Days | Cost |
|------|------|------|
| Standard | 5-7 business days | $4.99 |
| Express | 2-3 business days | $12.99 |
| Overnight | Next business day | $24.99 |

## Free Shipping

Free shipping on orders over $50.

## International

International shipping: 10-14 business days. Customs fees may apply.

## Tracking

All orders include tracking. Check status at: example.com/track
```

---

## Configuration

### Permissions

Control which skills are available:

```jsonc
{
  "permissions": {
    "skill": "allow"
    // or selective:
    // "skill": {
    //   "shipping": "allow",
    //   "billing": "deny"
    // }
  }
}
```

---

## Real-World Example: Customer Support

### Directory Structure

```
.kuralle/
├── prompts/
│   └── support.md
├── skill/
│   ├── return-policy/
│   │   └── SKILL.md
│   ├── shipping-inquiry/
│   │   └── SKILL.md          # ← Procedural skill example below
│   └── product-catalog/
│       └── SKILL.md
└── tools/
    ├── create_ticket/
    │   └── index.ts
    ├── check_order/
    │   └── index.ts
    ├── check_shipping_status/
    │   └── index.ts
    └── process_refund/
        └── index.ts
```

### Informational Skill: Return Policy

```markdown
---
name: return-policy
description: Return and refund policy for customer inquiries
---

# Return Policy

## Timeframe
- 30 days from purchase date
- Original receipt or order number required
- Item must be in resalable condition

## Process
1. Verify purchase date (within 30 days)
2. Check item condition (original tags, no damage)
3. Confirm refund method (original payment method)
4. Process refund within 5-7 business days

## Exclusions
- Personalized items (engraved, custom sizing)
- Perishable goods (food, cosmetics)
- Final sale items
- Gift cards

## Exchange Option
Customers can opt for exchange instead of refund.
```

### Procedural Skill: Shipping Inquiry

```markdown
---
name: shipping-inquiry
description: Process for handling shipping status inquiries
---

# Shipping Information

## Delivery Timeframes
- Standard: 5-7 business days ($4.99)
- Express: 2-3 business days ($12.99)
- Overnight: Next business day ($24.99)

## Free Shipping
Free shipping on orders over $50.

## Tracking
All orders include tracking. Customers can check at example.com/track

---

# Shipping Inquiry Process

When a customer asks about shipping status or delivery:

1. **Collect tracking information**
   Ask: "Could you please provide your order number or tracking number?"
   Accept formats:
   - Order ID: ORDER-XXXXX
   - Tracking number: 1ZXXX, TXXX, etc.

2. **Check shipping status**
   Call: `check_shipping_status` tool
   ```typescript
   check_shipping_status({ orderId: "ORDER-12345" })
   // or
   check_shipping_status({ trackingNumber: "1Z999AA1" })
   ```

3. **Explain the result based on status**

   **If In Transit:**
   "Good news! Your package is on its way. It's currently in [city, state]
    and should arrive by [estimated delivery date]."

   **If Out for Delivery:**
   "Great news! Your package is out for delivery today. You should receive
    it by the end of the day."

   **If Delivered:**
   "Your package was delivered on [date] to [location]. Is there anything
    else I can help you with?"

   **If Delayed:**
   "I apologize for the delay. Your package is currently delayed due to
    [reason]. The updated delivery estimate is [new date]. I can help you with:
    - Checking if expedited shipping is available
    - Issuing a refund for the shipping cost
    - Just waiting for the updated delivery date
    What would you prefer?"

4. **If not found:**
   "I couldn't find that order number. Could you please:
    - Double-check the number for any typos
    - Provide the email address used for the order
    - Check your email for the order confirmation"
```

### Tool: Create Ticket

```typescript
// .kuralle/tools/create_ticket/index.ts
import { z } from 'zod';
import type { ToolDefinition } from '@kuralle-agents/core';

export const tool: ToolDefinition = {
  description: 'Create a support ticket in the ticketing system',
  inputSchema: z.object({
    subject: z.string().describe('Ticket subject'),
    description: z.string().describe('Issue description'),
    priority: z.enum(['low', 'medium', 'high']).describe('Ticket priority'),
    customerId: z.string().describe('Customer ID'),
  }),
  execute: async ({ subject, description, priority, customerId }) => {
    // THIS ACTUALLY DOES SOMETHING
    const ticket = await ticketingSystem.create({
      subject,
      description,
      priority,
      customerId,
    });
    return {
      ticketId: ticket.id,
      status: ticket.status,
      createdAt: ticket.createdAt
    };
  },
};
```

### Configuration

```jsonc
{
  "agents": {
    "support": {
      "type": "llm",
      "description": "Customer support agent",
      "prompt": { "file": "./.kuralle/prompts/support.md" },
      "tools": ["skill", "create_ticket", "check_order", "process_refund"]
    }
  },
  "tools": {
    "skill": {
      "type": "skill-loader",
      "paths": ["./.kuralle/skill"]
    },
    "create_ticket": {
      "type": "module",
      "entry": "./.kuralle/tools/create_ticket/index.ts"
    },
    "check_order": {
      "type": "module",
      "entry": "./.kuralle/tools/check_order/index.ts"
    },
    "process_refund": {
      "type": "module",
      "entry": "./.kuralle/tools/process_refund/index.ts"
    }
  }
}
```

---

## Conversation Flow Example

```
User: "I want to return my order"

Agent: "I can help with that. First, let me check your order details.
         What's your order number?"

User: "ORDER-12345"

[Agent calls: check_order({ orderId: "ORDER-12345" })]

Agent: "I see your order from December 15th. Let me check our return policy."

[Agent calls: skill("return-policy")]

Agent: "Good news! You're within the 30-day window and the item qualifies.
         Let me create a return ticket for you."

[Agent calls: create_ticket({ subject: "Return Request - ORDER-12345", ... })]

Agent: "I've created return ticket TKT-456. You'll receive a shipping label
         via email within 24 hours. Once we receive the item, your refund
         will be processed within 5-7 business days."
```

---

## Key Insights

| Component | Role | Example |
|-----------|------|---------|
| **Skill** | Knowledge reference | "Return policy is 30 days..." |
| **Tool** | Executes action | `create_ticket()` actually creates ticket |
| **Flow** | Orchestrates process | Return flow: collect → verify → process |
| **Agent** | Decides what to do | "I'll check the policy, then create a ticket" |

**Skills tell the agent WHAT the rules are. Tools DO the work. Flows orchestrate the process.**

---

## Quick Decision Guide

| User Question | Use | Why |
|---------------|-----|-----|
| "What's your refund policy?" | **Informational Skill** | Static information |
| "How long does shipping take?" | **Informational Skill** | Reference data |
| "Where is my order?" | **Procedural Skill** OR **Flow** | 2-3 step process |
| "Is this product in stock?" | **Tool** (check_inventory) | Direct lookup |
| "Create a return ticket" | **Tool** (create_ticket) | Single action |
| "Check if I qualify for return" | **Flow** (return-flow) | Multi-step, needs state |
| "Process my refund" | **Tool** (process_refund) | Direct action |

### Procedural Skill vs Flow: Quick Reference

| Use Procedural Skill When... | Use Flow When... |
|---------------------------|------------------|
| 2-3 step process | 4+ step process |
| Low risk if steps vary | Critical business logic |
| Benefits from LLM flexibility | Needs guaranteed execution |
| Don't need state persistence | Must track state across turns |
| Quick to author, simple scenario | Worth the setup complexity |

---

## CLI Commands

```bash
# List all loaded skills
kuralle list skills

# Debug shows skill files
kuralle debug
```

---

## Best Practices

### For All Skills

1. **Keep skills focused** - One topic per skill
2. **Use clear descriptions** - Helps LLM know when to use each skill
3. **Organize by domain** - Group related skills (shipping, billing, etc.)
4. **Version skills independently** - Easier to update policies
5. **Don't duplicate prompts** - Put foundational rules in prompts, not skills
6. **Use tables for structured data** - Easier for LLM to parse
7. **Include examples** - Shows LLM how to apply the information

### For Procedural Skills

8. **Number steps explicitly** - Use "1.", "2.", "3." format
9. **Be specific about tool usage** - Include exact tool names and parameters
10. **Handle edge cases** - Include "if delayed", "if error", "if not found" branches
11. **Provide response templates** - Give examples of what to say in each scenario
12. **Separate information from process** - Use sections or different skills
13. **Keep it under 5 steps** - Beyond that, consider using a Flow
14. **Test with real conversations** - Verify LLM follows the guidance consistently

### Procedural Skill Template

```markdown
---
name: [process-name]
description: [What this handles]
---

# [Topic] Information (Reference)

## Key Facts
- Fact 1
- Fact 2

## Data / Tables
| Column 1 | Column 2 |
|----------|----------|
| Data 1   | Data 2   |

---

# [Process] Process (Instructions)

When handling [scenario]:

1. **[Step 1]**
   - Ask: "[What to collect]"
   - Tool: `[tool_name]` (if applicable)

2. **[Step 2]**
   - Do: "[Action to take]"
   - If [condition]: "[alternative action]"

3. **[Step 3]**
   - Explain: "[How to respond]"
   - For [scenario]: "[specific response]"
```

---

## See Also

- [Tools Guide](tools.md) - Tool contracts and schemas
- [Flows Guide](flows.md) - Structured conversation flows
