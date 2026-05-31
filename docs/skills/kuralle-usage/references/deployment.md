# Deployment Guide

## Contents

- Hono server
- Cloudflare Workers
- Session stores

## Hono server

Use `@kuralle-agents/hono-server` for REST/SSE/WebSocket routing.

## Cloudflare Workers

Use `@kuralle-agents/cf-agent` to run in Durable Objects with SQLite store.

## Session stores

Pick one:

- Memory (default) for local dev
- Redis for production
- Postgres for production
