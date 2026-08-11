// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import starlight from '@astrojs/starlight';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import tailwindcss from '@tailwindcss/vite';
import starlightLlmsTxt from 'starlight-llms-txt';

const [coreTypeDoc, coreTypeDocSidebar] = createStarlightTypeDocPlugin();
const [honoTypeDoc, honoTypeDocSidebar] = createStarlightTypeDocPlugin();
const [toolsTypeDoc, toolsTypeDocSidebar] = createStarlightTypeDocPlugin();
const [ragTypeDoc, ragTypeDocSidebar] = createStarlightTypeDocPlugin();
const [fsTypeDoc, fsTypeDocSidebar] = createStarlightTypeDocPlugin();
const [piDriverTypeDoc, piDriverTypeDocSidebar] = createStarlightTypeDocPlugin();
const [cfAgentTypeDoc, cfAgentTypeDocSidebar] = createStarlightTypeDocPlugin();

const typeDocConfig = {
  useCodeBlocks: true,
  parametersFormat: 'htmlTable',
  propertyMembersFormat: 'htmlTable',
  disableSources: true,
  excludeExternals: true,
  plugin: ['typedoc-plugin-zod', 'typedoc-plugin-frontmatter'],
};

const plugins = [
  coreTypeDoc({
    sidebar: { label: '@kuralle-agents/core' },
    entryPoints: ['../../packages/core/src/index.ts'],
    output: 'api/core',
    tsconfig: '../../packages/core/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  honoTypeDoc({
    sidebar: { label: '@kuralle-agents/hono-server' },
    entryPoints: ['../../packages/hono-server/src/index.ts'],
    output: 'api/hono-server',
    tsconfig: '../../packages/hono-server/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  toolsTypeDoc({
    sidebar: { label: '@kuralle-agents/tools' },
    entryPoints: ['../../packages/tools/src/index.ts'],
    output: 'api/tools',
    tsconfig: '../../packages/tools/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  ragTypeDoc({
    sidebar: { label: '@kuralle-agents/rag' },
    entryPoints: ['../../packages/rag/src/index.ts'],
    output: 'api/rag',
    tsconfig: '../../packages/rag/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  fsTypeDoc({
    sidebar: { label: '@kuralle-agents/fs' },
    entryPoints: ['../../packages/fs/src/index.ts'],
    output: 'api/fs',
    tsconfig: '../../packages/fs/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  piDriverTypeDoc({
    sidebar: { label: '@kuralle-agents/pi-driver' },
    entryPoints: ['../../packages/pi-driver/src/index.ts'],
    output: 'api/pi-driver',
    tsconfig: '../../packages/pi-driver/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  cfAgentTypeDoc({
    sidebar: { label: '@kuralle-agents/cf-agent' },
    entryPoints: ['../../packages/cf-agent/src/index.ts'],
    output: 'api/cf-agent',
    tsconfig: '../../packages/cf-agent/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  starlightLlmsTxt({
    projectName: 'Kuralle',
    customSets: [
      {
        label: 'Guides',
        description: 'Guides for using Kuralle',
        paths: ['guides/**'],
      },
      {
        label: 'Examples',
        description: 'Runnable production examples and focused integration labs',
        paths: ['examples/**'],
      },
      {
        label: 'API Reference',
        description: 'API reference for Kuralle packages',
        paths: ['api/**'],
      },
    ],
  }),
];

const sidebar = [
  { label: 'Overview', link: '/' },
  {
    label: 'Examples',
    collapsed: false,
    items: [
      { label: 'Catalogue', link: '/examples/' },
      { label: 'Agentic Commerce', link: '/examples/agentic-commerce/' },
    ],
  },
  {
    label: 'Start',
    collapsed: false,
    items: [
      { label: 'Quickstart', link: '/guides/quickstart' },
      { label: 'Build an Agent', link: '/guides/build-an-agent' },
      { label: 'File-authored Agents', link: '/guides/file-authored-agents' },
      { label: 'Templates', link: '/guides/templates' },
    ],
  },
  {
    label: 'Core model',
    collapsed: false,
    items: [
      { label: 'Agents', link: '/guides/agents' },
      { label: 'Flows', link: '/guides/flows' },
      { label: 'Flow Execution Model', link: '/guides/flow-execution' },
      { label: 'Tools', link: '/guides/tools' },
      { label: 'Routing & Handoffs', link: '/guides/routing' },
    ],
  },
  {
    label: 'Context & state',
    collapsed: false,
    items: [
      { label: 'Sessions & State', link: '/guides/sessions' },
      { label: 'Memory', link: '/guides/memory' },
      { label: 'Knowledge & Retrieval', link: '/guides/knowledge' },
      { label: 'Skills', link: '/guides/skills' },
      { label: 'Agent Plugins', link: '/guides/plugins' },
      { label: 'MCP', link: '/guides/mcp' },
      { label: 'Workspace (Filesystem & Shell)', link: '/guides/workspace' },
      { label: 'Multimodal Input', link: '/guides/multimodal' },
    ],
  },
  {
    label: 'Production',
    collapsed: false,
    items: [
      { label: 'Pi Driver', link: '/guides/pi-driver' },
      { label: 'Tool Policy', link: '/guides/policy' },
      { label: 'Durable Execution', link: '/guides/durable-execution' },
      { label: 'Engagement & Messaging', link: '/guides/engagement' },
      { label: 'Deployment', link: '/guides/deployment' },
      { label: 'Agent Builder in React', link: '/guides/agent-builder-react' },
      { label: 'Agent Definitions in Your Database', link: '/guides/agent-definitions-database' },
      { label: 'Observability', link: '/guides/observability' },
      { label: 'CLI & Devtools', link: '/guides/cli' },
    ],
  },
  {
    label: 'API Reference',
    collapsed: true,
    items: [
      {
        label: '@kuralle-agents/core',
        collapsed: true,
        items: [coreTypeDocSidebar],
      },
      {
        label: '@kuralle-agents/hono-server',
        collapsed: true,
        items: [honoTypeDocSidebar],
      },
      {
        label: '@kuralle-agents/tools',
        collapsed: true,
        items: [toolsTypeDocSidebar],
      },
      {
        label: '@kuralle-agents/rag',
        collapsed: true,
        items: [ragTypeDocSidebar],
      },
      {
        label: '@kuralle-agents/fs',
        collapsed: true,
        items: [fsTypeDocSidebar],
      },
      {
        label: '@kuralle-agents/pi-driver',
        collapsed: true,
        items: [piDriverTypeDocSidebar],
      },
      {
        label: '@kuralle-agents/cf-agent',
        collapsed: true,
        items: [cfAgentTypeDocSidebar],
      },
    ],
  },
];

export default defineConfig({
  site: 'https://agents.kuralle.com',
  integrations: [
    starlight({
      title: 'Kuralle',
      social: [
        {
          icon: 'github',
          href: 'https://github.com/kuralle/kuralle-agents',
          label: 'GitHub',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/kuralle/kuralle-agents/edit/main/apps/docs/',
      },
      plugins,
      sidebar,
      expressiveCode: {
        themes: ['houston', 'one-light'],
      },
      customCss: ['./src/styles/global.css'],
    }),
    // Registered after starlight, which sets up astro-expressive-code and errors if mdx()
    // precedes it. Without this integration MDX never extended the markdown config, so GFM
    // reached `.md` and not `.mdx` — every pipe table in every guide rendered as a
    // paragraph of literal `|` characters, silently, because a broken table still builds.
    mdx({ gfm: true, extendMarkdownConfig: true }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
