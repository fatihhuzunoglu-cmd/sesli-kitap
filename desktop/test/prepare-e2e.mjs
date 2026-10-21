// Fills a computer-app library for the phone E2E runs, the way a user would: the window converts the scanned test
// PDF, and an audiobook is downloaded from the E2E server's stand-in Internet Archive.
// node desktop/test/prepare-e2e.mjs <library dir> <catalog base, e.g. http://127.0.0.1:8000>
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const [library, catalog] = process.argv.slice(2);
if (!library || !catalog) throw new Error('usage: prepare-e2e.mjs <library> <catalog base>');

const child = spawn(process.execPath, [join(here, '..', 'dist', 'cli.mjs'), '--port', '47931', '--library', library, '--catalog', catalog], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    process.stdout.write(d);
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) resolve(`http://127.0.0.1:${m[1]}`);
  });
  child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole('tab', { name: 'Dönüştür' }).click();
  await page.locator('[data-testid=file-input]').setInputFiles([join(here, '..', '..', 'e2e', 'fixtures', 'taranmis-kitap.pdf')]);
  await page.locator('[data-testid=convert-done]').waitFor({ timeout: 600000 });
  console.log(await page.locator('[data-testid=convert-done]').textContent());
  await browser.close();

  const { items } = await (await fetch(`${base}/api/search?q=masal&kind=audio`)).json();
  const { id } = await (await fetch(`${base}/api/download`, { method: 'POST', body: JSON.stringify(items[0]) })).json();
  for (let i = 0; ; i++) {
    const item = (await (await fetch(`${base}/api/library`)).json()).items.find((x) => x.id === id);
    if (item.status === 'ready') break;
    if (item.status === 'error' || i > 600) throw new Error(`audiobook download: ${JSON.stringify(item)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('library:', JSON.stringify((await (await fetch(`${base}/api/library`)).json()).items.map((i) => [i.kind, i.title, i.count])));
} finally {
  child.kill();
}
