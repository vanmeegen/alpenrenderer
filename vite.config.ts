import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The commit this build came from, for the check panel: a report from a phone can then be matched to the code. */
function buildStamp(): string {
  let commit = 'dev';
  try { commit = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git: dev */ }
  return `${commit} · ${new Date().toISOString().slice(0, 10)}`;
}

// Relative base: the same build serves from GitHub Pages under
// /alpenrenderer/ and from any static server or file path.
export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(buildStamp()) },
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  server: { host: true },
});
