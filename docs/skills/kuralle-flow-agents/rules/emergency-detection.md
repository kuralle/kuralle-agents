# Rule: Emergency Detection Criteria

## The Rule

Emergency tools must have EXPLICIT criteria for what IS and IS NOT an emergency.

## Why

Vague emergency definitions cause:
- False positives: "My child is sick" triggers emergency
- User frustration: Non-emergencies treated as emergencies
- Resource waste: ETU receives non-urgent cases

## Pattern

### ❌ Wrong

```
emergency: User has emergency symptoms
```

Too vague - what counts as "emergency symptoms"?

### ✅ Right

```
EMERGENCY TOOL - ONLY call for these SPECIFIC situations:
- Not breathing / cannot breathe
- Severe bleeding / hemorrhage
- Unconscious / unresponsive
- Choking
- Severe chest pain (heart attack symptoms)
- Active labour emergency
- Major trauma / accident

DO NOT call emergency for:
- General sickness ("my child is sick", "feeling unwell")
- Fever, cold, cough (unless severe difficulty breathing)
- Routine check-ups
- Questions about symptoms
- Vague requests ("I need help")
```

## Testing

Always test these scenarios:

| Input | Expected |
|-------|----------|
| "My child is sick" | NOT emergency |
| "My baby is not breathing" | Emergency |
| "I have chest pain" | Emergency (cautious) |
| "Little chest pain when coughing" | NOT emergency |
| "I need help" | Ask clarification, NOT emergency |

## Implementation

```javascript
// In prompt
const triagePrompt = `...
EMERGENCY TOOL - ONLY call emergency({}) for these:
- Not breathing
- Severe bleeding
- Unconscious
- Choking
- Severe chest pain
- Active labour
- Major trauma

DO NOT call emergency for:
- General sickness
- Fever, cold
- Vague requests
...`;
```

## Edge Cases

- **Chest pain**: Err on side of caution - call emergency
- **Child + fever**: Ask severity, don't assume emergency
- **"I need help"**: Ask for clarification, don't route to human or emergency

The goal is to catch TRUE emergencies without overwhelming the ETU with non-urgent cases.
