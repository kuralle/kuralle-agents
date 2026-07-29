# Kuralle documentation

The documentation site is built with Astro 6 and Starlight. Hand-authored content lives in `src/content/docs`; TypeDoc API pages are generated at build time from the package entry points configured in `astro.config.mjs`.

## Run locally

From the repository root:

```bash
bun install
bun run --cwd apps/docs dev
```

Open `http://localhost:4321`.

## Production build

```bash
bun run --cwd apps/docs build
bun run --cwd apps/docs preview
```

The build validates MDX, navigation, TypeDoc generation, and the static output. Generated API pages should be changed through package source or TypeDoc configuration, not edited directly under `src/content/docs/api`.

## Content map

- `src/content/docs/index.mdx` — product overview
- `src/content/docs/examples/` — runnable examples catalogue
- `src/content/docs/guides/` — task, concept, and operations documentation
- `src/examples/` — raw code imported into MDX
- `src/components/` — docs-only Astro presentation components
- `src/styles/global.css` — Starlight theme overrides

Edit links point to the corresponding file on the `main` branch of [kuralle/kuralle-agents](https://github.com/kuralle/kuralle-agents).
