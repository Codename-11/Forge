import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Forge",
  titleTemplate: ":title — Forge",
  description:
    "Forge — a fast, minimalist, keyboard-driven project management platform with first-class agent support. Workspaces, sprints, dispatch rules, webhooks, and an MCP surface for Hermes.",
  lang: "en-US",
  // Same pattern as Lucid: served under /docs/ in production (GH Pages
  // deploys to <owner>.github.io/forge/docs/) and proxied at /docs/ from
  // the Next dev server in development. Change to "/" if you publish at
  // the apex.
  base: "/docs/",
  cleanUrls: false,
  // Last-updated reads `git log` per page. Disabled because the Docker
  // prod builder excludes `.git` and doesn't ship git, so this would
  // fail every build. The dashboard's in-app docs viewer never shows
  // the last-updated stamp anyway.
  lastUpdated: false,
  appearance: true, // light is default; users can flip to dark
  ignoreDeadLinks: [
    /^https?:\/\/localhost/,
    /^\/api\//,
    /^\/w\//,
  ],

  head: [
    // Fonts — match the dashboard exactly: Inter (sans) + JetBrains
    // Mono (identifiers). No display/scoreboard face — the warm paper
    // aesthetic is type-led but unornamented.
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],

    // Favicons
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/favicon.svg" }],
    ["link", { rel: "mask-icon", href: "/docs/forge-mark.svg", color: "#d97706" }],
    ["link", { rel: "apple-touch-icon", href: "/docs/forge-app-icon.svg" }],

    // Theme color — warm paper / graphite
    ["meta", { name: "theme-color", content: "#fef9f0", media: "(prefers-color-scheme: light)" }],
    ["meta", { name: "theme-color", content: "#1c1917", media: "(prefers-color-scheme: dark)" }],
    ["meta", { name: "color-scheme", content: "light dark" }],
    ["meta", { name: "author", content: "Axiom-Labs" }],

    // Open Graph
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Forge" }],
    ["meta", { property: "og:title", content: "Forge — Documentation" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "A fast, minimalist, keyboard-driven project management platform with first-class agent support.",
      },
    ],
    ["meta", { property: "og:locale", content: "en_US" }],

    // Twitter
    ["meta", { name: "twitter:card", content: "summary" }],
    ["meta", { name: "twitter:title", content: "Forge — Documentation" }],
    [
      "meta",
      {
        name: "twitter:description",
        content:
          "A fast, minimalist, keyboard-driven project management platform with first-class agent support.",
      },
    ],
  ],

  themeConfig: {
    siteTitle: "FORGE / DOCS",
    logo: { src: "/forge-mark.svg", width: 22, height: 22 },

    nav: [
      { text: "Guide", link: "/guide/welcome.html", activeMatch: "/guide/" },
      { text: "Concepts", link: "/concepts/primitives.html", activeMatch: "/concepts/" },
      { text: "Agents", link: "/agents/overview.html", activeMatch: "/agents/" },
      { text: "Automation", link: "/automation/webhooks.html", activeMatch: "/automation/" },
      { text: "Reference", link: "/reference/mcp.html", activeMatch: "/reference/" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Welcome", link: "/guide/welcome.html" },
            { text: "Architecture", link: "/guide/architecture.html" },
            { text: "Quickstart", link: "/guide/quickstart.html" },
            { text: "Local Development", link: "/guide/local-development.html" },
          ],
        },
        {
          text: "Working in Forge",
          items: [
            { text: "Inbox", link: "/guide/inbox.html" },
            { text: "Workspaces", link: "/guide/workspaces.html" },
            { text: "Today Widget", link: "/guide/today-widget.html" },
            { text: "What's New", link: "/guide/whats-new.html" },
            { text: "Issues", link: "/guide/issues.html" },
            { text: "Slash Commands", link: "/guide/slash-commands.html" },
            { text: "Watching", link: "/guide/watching.html" },
            { text: "Quick Notes", link: "/guide/quick-notes.html" },
            { text: "Daily Journal", link: "/guide/journal.html" },
            { text: "Saved Views", link: "/guide/saved-views.html" },
            { text: "Projects & Initiatives", link: "/guide/projects-and-initiatives.html" },
            { text: "Sprints", link: "/guide/sprints.html" },
            { text: "Time & Attachments", link: "/guide/time-and-attachments.html" },
          ],
        },
        {
          text: "Operating Forge",
          items: [
            { text: "Settings", link: "/guide/settings.html" },
            { text: "Keyboard", link: "/guide/keyboard.html" },
          ],
        },
      ],
      "/concepts/": [
        {
          text: "Foundations",
          items: [
            { text: "Primitives", link: "/concepts/primitives.html" },
            { text: "Scopes & Tenancy", link: "/concepts/scopes-and-tenancy.html" },
            { text: "Activity & Audit", link: "/concepts/activity-and-audit.html" },
            { text: "Design Language", link: "/concepts/design-language.html" },
          ],
        },
        {
          text: "Orchestration",
          items: [
            { text: "Goals & the Loop", link: "/concepts/orchestration.html" },
            { text: "Action Requests", link: "/concepts/action-requests.html" },
            { text: "Comments", link: "/concepts/comments.html" },
          ],
        },
      ],
      "/agents/": [
        {
          text: "Agents in Forge",
          items: [
            { text: "Overview", link: "/agents/overview.html" },
            { text: "Agents, Tiers & Transports", link: "/agents/providers-and-transports.html" },
            { text: "Runtimes", link: "/agents/runtimes.html" },
            { text: "Hermes Integration", link: "/agents/hermes.html" },
            { text: "Chat & Dispatch Engines", link: "/agents/engines.html" },
            { text: "Auto-dispatch", link: "/agents/auto-dispatch.html" },
            { text: "Dispatch Rules", link: "/agents/dispatch-rules.html" },
            { text: "SLAs & Watchdogs", link: "/agents/slas-and-watchdogs.html" },
            { text: "AI Triage & Coach", link: "/agents/ai-triage-and-coach.html" },
          ],
        },
      ],
      "/automation/": [
        {
          text: "Automation Surfaces",
          items: [
            { text: "Webhooks", link: "/automation/webhooks.html" },
            { text: "Plugins", link: "/automation/plugins.html" },
            { text: "API Keys", link: "/automation/api-keys.html" },
            { text: "Email-to-issue", link: "/automation/email-ingest.html" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "API Reference",
          items: [
            { text: "MCP Tools", link: "/reference/mcp.html" },
            { text: "tRPC Routers", link: "/reference/trpc.html" },
            { text: "Events", link: "/reference/events.html" },
            { text: "Environment", link: "/reference/env.html" },
          ],
        },
      ],
    },

    outline: { level: [2, 3], label: "On this page" },

    socialLinks: [],

    search: {
      provider: "local",
      options: {
        detailedView: true,
      },
    },

    // Edit-link is wired but the repo isn't public yet. Flip the URL
    // when the repo flips public.
    editLink: {
      pattern: "https://github.com/Codename-11/forge/edit/master/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Axiom-Labs · built for humans and agents",
      copyright: "Forge — minimalist, keyboard-driven, agent-native",
    },

    docFooter: {
      prev: "Previous",
      next: "Next",
    },
  },

  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark",
    },
    lineNumbers: false,
  },

  vite: {
    server: { port: 5181, strictPort: false },
  },
});
