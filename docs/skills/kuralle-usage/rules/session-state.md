# Rule: Session State Must Persist

## MUST

- Reuse `sessionId` across turns.
- Store sessions in Redis/Postgres for production.

## MUST NOT

- Create new sessions per user turn.
- Lose working memory between steps.
