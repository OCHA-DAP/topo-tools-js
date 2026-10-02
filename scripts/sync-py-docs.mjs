#!/usr/bin/env node
// Symlinks topo-tools-py's docs/pages into the Starlight collection so /docs/
// renders the py docs. PY_DOCS_DIR overrides the sibling-checkout default.

import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const source = resolve(ROOT, process.env.PY_DOCS_DIR ?? "../topo-tools-py/docs/pages");
const dest = resolve(ROOT, "src/content/docs/docs");

if (!existsSync(source)) {
  console.error(`py docs not found at ${source} (set PY_DOCS_DIR)`);
  process.exit(1);
}

await mkdir(dirname(dest), { recursive: true });
await rm(dest, { recursive: true, force: true });
await symlink(source, dest, "dir");
console.log(`linked ${dest.replace(ROOT + "/", "")} -> ${source}`);
