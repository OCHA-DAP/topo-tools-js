import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import svelte from "@astrojs/svelte";
import rehypeAstroRelativeMarkdownLinks from "astro-rehype-relative-markdown-links";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";

// Empty for a custom domain; "/<repo>" for GitHub's default project-pages
// subpath. Set by .github/workflows/deploy.yml via actions/configure-pages.
const base = process.env.BASE_PATH ?? "";
const iconBase = base ? `${base}/` : "/";

export default defineConfig({
  site: "https://topo-tools.org",
  base,
  redirects: { "/talk": "/intro" },
  integrations: [
    starlight({
      title: "Topology Tools",
      favicon: "/icons/icon-192.png",
      customCss: ["./src/styles/hdx-tokens.css", "./src/styles/starlight-hdx.css"],
      components: {
        Head: "./src/lib/components/starlight/Head.astro",
        Header: "./src/lib/components/starlight/Header.astro",
        ThemeProvider: "./src/lib/components/starlight/ThemeProvider.astro",
        ThemeSelect: "./src/lib/components/starlight/ThemeSelect.astro",
      },
      sidebar: [
        { label: "Overview", link: "/docs/" },
        { label: "Agents", items: [{ autogenerate: { directory: "docs/agents" } }] },
        { label: "1. Schema", items: [{ autogenerate: { directory: "docs/1-schema" } }] },
        { label: "2. Topology", items: [{ autogenerate: { directory: "docs/2-topology" } }] },
        { label: "3. Edge matching", items: [{ autogenerate: { directory: "docs/3-edge" } }] },
        { label: "4. Codes", items: [{ autogenerate: { directory: "docs/4-codes" } }] },
        { label: "5. Names", items: [{ autogenerate: { directory: "docs/5-names" } }] },
        { label: "6. Packaging", items: [{ autogenerate: { directory: "docs/6-packaging" } }] },
      ],
    }),
    svelte(),
    AstroPWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: "auto",
      // Explicit trailing slash so SW registration/manifest scope is a proper
      // directory prefix — the default (Astro's `base`, no trailing slash) is
      // a literal string prefix per the SW spec and could over-match a
      // hypothetical sibling path.
      scope: iconBase,
      // App-shell precache only — large WASM/GeoJSON are runtime-cached by
      // the hand-rolled fetch handler in src/sw.ts when the user clicks
      // "Enable offline".
      injectManifest: {
        globPatterns: ["**/*.{html,css,js,ico,svg,png,webmanifest,woff,woff2}"],
        globIgnores: ["**/duckdb/**", "**/data/**", "**/docs/**", "pagefind/**"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      manifest: {
        name: "Topology Tools",
        short_name: "Topology Tools",
        description: "Browser-only geospatial topology utilities. Runs entirely in your browser.",
        theme_color: "#18614c",
        background_color: "#ffffff",
        display: "standalone",
        icons: [
          { src: `${iconBase}icons/icon-192.png`, sizes: "192x192", type: "image/png" },
          { src: `${iconBase}icons/icon-512.png`, sizes: "512x512", type: "image/png" },
          {
            src: `${iconBase}icons/icon-maskable-512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  markdown: {
    processor: unified({
      rehypePlugins: [
        [rehypeAstroRelativeMarkdownLinks, { collectionBase: false, trailingSlash: "always" }],
      ],
    }),
  },
  vite: {
    resolve: {
      // Resolve MDX imports in the symlinked py docs from this project's node_modules.
      preserveSymlinks: true,
      alias: {
        $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      },
    },
    optimizeDeps: {
      exclude: ["@duckdb/duckdb-wasm"],
    },
    build: {
      // Astro's static SSR prunes scoped CSS for components that don't render
      // at SSR time (e.g. {#if} branches). Disabling code-split keeps every
      // component's styles in the client bundle.
      cssCodeSplit: false,
    },
  },
});
