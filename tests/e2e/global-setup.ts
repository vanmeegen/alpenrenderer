import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Generates the fixture tiles and makes sure a build exists to serve. */
export default function globalSetup() {
  const root = join(here, '..', '..');
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing: run `bun run build` before the E2E tests');
  }
  execFileSync('bun', [join(here, 'fixtures', 'gen.mjs')], { stdio: 'inherit' });
}
