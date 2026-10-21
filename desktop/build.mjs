// Builds the computer app into dist/: the server (for Electron and for plain Node), the window's script,
// the phone app's extraction engine page and its OCR data.
import { build } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });

const common = { bundle: true, logLevel: 'warning', target: 'es2022' };
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(dist, 'main.cjs'), platform: 'node', format: 'cjs', external: ['electron'] });
await build({
  ...common,
  entryPoints: [join(here, 'src/cli.ts')],
  outfile: join(dist, 'cli.mjs'),
  platform: 'node',
  format: 'esm',
  // qrcode is CommonJS; give the ESM bundle a require() for it.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await build({ ...common, entryPoints: [join(here, 'ui/app.ts')], outfile: join(dist, 'app.js'), platform: 'browser', format: 'iife' });
for (const f of ['index.html', 'style.css']) copyFileSync(join(here, 'ui', f), join(dist, f));
copyFileSync(join(here, 'icon.png'), join(dist, 'icon.png'));

// The engine page the phone app embeds (`npm run build:engine` in the app folder makes it).
const generated = readFileSync(join(root, 'src/engine/engineHtml.generated.ts'), 'utf8');
writeFileSync(join(dist, 'engine.html'), JSON.parse(generated.slice(generated.indexOf('= ') + 2, generated.lastIndexOf(';'))));
cpSync(join(root, 'assets/ocr'), join(dist, 'ocr'), { recursive: true });
console.log('desktop: dist ready');
