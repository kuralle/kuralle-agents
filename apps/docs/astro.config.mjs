// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import tailwindcss from '@tailwindcss/vite';
import starlightLlmsTxt from 'starlight-llms-txt';

const [coreTypeDoc, coreTypeDocSidebar] = createStarlightTypeDocPlugin();
const [honoTypeDoc, honoTypeDocSidebar] = createStarlightTypeDocPlugin();
const [toolsTypeDoc, toolsTypeDocSidebar] = createStarlightTypeDocPlugin();
const [ragTypeDoc, ragTypeDocSidebar] = createStarlightTypeDocPlugin();

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
    entryPoints: ['../../packages/kuralle-core/src/index.ts'],
    output: 'api/core',
    tsconfig: '../../packages/kuralle-core/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  honoTypeDoc({
    sidebar: { label: '@kuralle-agents/hono-server' },
    entryPoints: ['../../packages/kuralle-hono-server/src/index.ts'],
    output: 'api/hono-server',
    tsconfig: '../../packages/kuralle-hono-server/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  toolsTypeDoc({
    sidebar: { label: '@kuralle-agents/tools' },
    entryPoints: ['../../packages/kuralle-tools/src/index.ts'],
    output: 'api/tools',
    tsconfig: '../../packages/kuralle-tools/tsconfig.json',
    typeDoc: typeDocConfig,
  }),
  ragTypeDoc({
    sidebar: { label: '@kuralle-agents/rag' },
    entryPoints: ['../../packages/kuralle-rag/src/index.ts'],
    output: 'api/rag',
    tsconfig: '../../packages/kuralle-rag/tsconfig.json',
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
        label: 'API Reference',
        description: 'API reference for Kuralle packages',
        paths: ['api/**'],
      },
    ],
  }),
];

const sidebar = [
  { label: 'Overview', link: '/' },
  { label: 'Quickstart', link: '/guides/quickstart' },
  { label: 'Build an Agent', link: '/guides/build-an-agent' },
  { label: 'Templates', link: '/guides/templates' },
  {
    label: 'Guides',
    collapsed: false,
    items: [
      { label: 'Agents', link: '/guides/agents' },
      { label: 'Flows', link: '/guides/flows' },
      { label: 'Flow Execution Model', link: '/guides/flow-execution' },
      { label: 'Tools', link: '/guides/tools' },
      { label: 'Multimodal Input', link: '/guides/multimodal' },
      { label: 'Durable Execution', link: '/guides/durable-execution' },
      { label: 'Routing & Handoffs', link: '/guides/routing' },
      { label: 'Sessions & State', link: '/guides/sessions' },
      { label: 'Memory', link: '/guides/memory' },
      { label: 'Skills', link: '/guides/skills' },
      { label: 'Voice Agents', link: '/guides/voice' },
      { label: 'Engagement & Messaging', link: '/guides/engagement' },
      { label: 'Deployment', link: '/guides/deployment' },
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
    ],
  },
];

export default defineConfig({
  site: 'https://docs.kuralle.com',
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
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
