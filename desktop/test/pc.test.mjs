// Runs the computer app's server (dist/cli.mjs) and its window in Chromium: pairing code checks, phone uploads and
// downloads, audiobook downloads from a stand-in Internet Archive, and converting a scanned PDF and a page photo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'e2e', 'fixtures');
const mp3 = readFileSync(join(fixtures, 'ses-bolum.mp3'));
const TOKEN = 'TEST42';

// Stand-in for the Internet Archive: one two-chapter audiobook.
const archive = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/mock-archive/advancedsearch.php') {
    const librivox = !url.searchParams.get('q').includes('mediatype');
    return json({ response: { docs: librivox ? [{ identifier: 'masal_lv', title: 'Masallar', creator: 'Okuyan', language: 'tur', runtime: '0:00:40' }] : [] } });
  }
  if (url.pathname === '/mock-archive/metadata/masal_lv') {
    return json({ metadata: { title: 'Masallar', creator: 'Okuyan' }, files: [1, 2].map((n) => ({ name: `m_${n}.mp3`, format: 'VBR MP3', title: `Masal ${n}`, track: String(n), length: '20' })) });
  }
  if (url.pathname.startsWith('/mock-archive/download/masal_lv/')) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length });
    return res.end(mp3);
  }
  res.writeHead(404);
  res.end();
});

function startCli(args) {
  const child = spawn(process.execPath, [join(here, '..', 'dist', 'cli.mjs'), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

let strict;
let open;
let archivePort;
const dirs = [];

before(async () => {
  await new Promise((r) => archive.listen(0, '127.0.0.1', r));
  archivePort = archive.address().port;
  const lib = () => {
    const d = mkdtempSync(join(tmpdir(), 'skpc-'));
    dirs.push(d);
    return d;
  };
  strict = await startCli(['--port', '47911', '--library', lib(), '--token', TOKEN, '--strict']);
  open = await startCli(['--port', '47921', '--library', lib(), '--catalog', `http://127.0.0.1:${archivePort}`]);
});

after(() => {
  strict?.child.kill();
  open?.child.kill();
  archive.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const pkg = (title, texts) => JSON.stringify({ type: 'seslikitap', version: 1, title, author: null, language: 'tr', origin: 'pdf', sections: texts.map((text, i) => ({ title: `Sayfa ${i + 1}`, text })) });

test('a phone needs the pairing code; with it, it can send and fetch books', async () => {
  const b = strict.base;
  assert.equal((await fetch(`${b}/api/info`)).status, 401);
  assert.equal((await fetch(`${b}/api/info?t=WRONG1`)).status, 401);
  const info = await (await fetch(`${b}/api/info?t=${TOKEN.toLowerCase()}`)).json();
  assert.equal(info.app, 'seslikitap-pc');

  const body = pkg('Telefondan gelen', ['Birinci sayfa.', 'İkinci sayfa.']);
  const up = await fetch(`${b}/api/upload?name=x&t=${TOKEN}`, { method: 'POST', body });
  assert.equal(up.status, 200);
  const { id } = await up.json();
  const { items } = await (await fetch(`${b}/api/library?t=${TOKEN}`)).json();
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.title, i.count, i.status]), [[id, 'book', 'Telefondan gelen', 2, 'ready']]);
  assert.equal(await (await fetch(`${b}/api/library/${id}/package?t=${TOKEN}`)).text(), body);
  const dl = await fetch(`${b}/api/library/${id}/package?download=1&t=${TOKEN}`);
  assert.match(dl.headers.get('content-disposition'), /Telefondan%20gelen\.skitap/);

  const bad = await fetch(`${b}/api/upload?t=${TOKEN}`, { method: 'POST', body: '{"type":"x"}' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Sesli Kitap paketi değil/);
  // Searching, deleting and pairing are for the computer's own window, even with the code.
  assert.equal((await fetch(`${b}/api/search?q=abc&t=${TOKEN}`)).status, 403);
  assert.equal((await fetch(`${b}/api/library/${id}?t=${TOKEN}`, { method: 'DELETE' })).status, 403);
});

test('pairing shows a QR code with the address and code', async () => {
  const p = await (await fetch(`${open.base}/api/pair`)).json();
  assert.match(p.token, /^[A-Z2-9]{6}$/);
  assert.match(p.link, new RegExp(`^seslikitap://pc\\?u=http%3A%2F%2F[\\d.]+%3A${p.port}&t=${p.token}&n=`));
  assert.match(p.qr, /^<svg/);
});

test('an audiobook found online is downloaded chapter by chapter and streamed to phones with ranges', async () => {
  const b = open.base;
  const { items } = await (await fetch(`${b}/api/search?q=masal&kind=audio`)).json();
  assert.deepEqual(items.map((i) => [i.source, i.id]), [['librivox', 'masal_lv']]);
  const { id } = await (await fetch(`${b}/api/download`, { method: 'POST', body: JSON.stringify(items[0]) })).json();
  let item;
  for (let i = 0; i < 100; i++) {
    item = (await (await fetch(`${b}/api/library`)).json()).items.find((x) => x.id === id);
    if (item.status !== 'downloading') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual([item.kind, item.status, item.count, item.size], ['audio', 'ready', 2, mp3.length * 2]);
  const audio = await (await fetch(`${b}/api/library/${id}/audio`)).json();
  assert.deepEqual(audio.tracks.map((t) => [t.title, t.url]), [
    ['Masal 1', `/api/library/${id}/track/0`],
    ['Masal 2', `/api/library/${id}/track/1`],
  ]);
  const part = await fetch(`${b}${audio.tracks[1].url}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${mp3.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), mp3.subarray(100, 200));
});

test('the window converts a scanned PDF and page photos into ready books', async () => {
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  try {
    const page = await browser.newPage();
    page.on('dialog', (d) => void d.accept('Foto kitap'));
    await page.goto(open.base);
    await page.getByRole('tab', { name: 'Dönüştür' }).click();
    await page.locator('[data-testid=file-input]').setInputFiles([join(fixtures, 'taranmis-kitap.pdf')]);
    await page.locator('[data-testid=convert-done]').first().waitFor({ timeout: 300000 });
    await page.locator('[data-testid=file-input]').setInputFiles([join(fixtures, 'sayfa-foto.jpg')]);
    await page.locator('[data-testid=convert-done]').nth(1).waitFor({ timeout: 300000 });

    const { items } = await (await fetch(`${open.base}/api/library`)).json();
    const scanned = items.find((i) => i.title === 'taranmis-kitap' || /taranmis/i.test(i.title));
    assert.ok(scanned, JSON.stringify(items.map((i) => i.title)));
    const book = await (await fetch(`${open.base}/api/library/${scanned.id}/package`)).json();
    assert.equal(book.origin, 'pdf');
    assert.equal(book.sections.length, 3);
    assert.match(book.sections[0].text, /a wet cat walked in through the door/);
    assert.match(book.sections[2].text, /kasabanın ışıklarının birer birer yanışını/);

    const photo = items.find((i) => i.title === 'Foto kitap');
    const photoBook = await (await fetch(`${open.base}/api/library/${photo.id}/package`)).json();
    assert.equal(photoBook.origin, 'images');
    assert.match(photoBook.sections[0].text, /tozlu bir rafın arkasında/);
    assert.equal(photoBook.language, 'tr');

    await page.getByRole('tab', { name: 'Kitaplık' }).click();
    await page.getByText('Foto kitap').waitFor();
    await page.getByRole('tab', { name: 'Telefonu bağla' }).click();
    await page.locator('.qr svg').waitFor();
    assert.match(await page.locator('[data-testid=pair-code]').textContent(), /^[A-Z2-9]{6}$/);
  } finally {
    await browser.close();
  }
});
