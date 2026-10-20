// Runs the extractor WebView page (engine HTML) in real browser engines against the E2E fixture books.
// Engines: Playwright Chromium and WebKit (closest to iOS WKWebView); set CHROME=/path/to/chrome to add another build.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name) => readFileSync(join(root, 'e2e/fixtures', name));
const generated = readFileSync(join(root, 'src/engine/engineHtml.generated.ts'), 'utf8');
const HTML = JSON.parse(generated.slice(generated.indexOf('= ') + 2, generated.lastIndexOf(';')));
const CHUNK = 384 * 1024;

const engines = [
  ['chromium', () => chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})],
  ['webkit', () => webkit.launch()],
];

class Engine {
  constructor(page) {
    this.page = page;
    this.n = 0;
    this.ocrLoaded = false;
  }

  static async open(browser) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__msgs = [];
      window.ReactNativeWebView = { postMessage: (m) => window.__msgs.push(JSON.parse(m)) };
    });
    await page.goto('about:blank');
    await page.setContent(HTML);
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'ready'), null, { timeout: 30000 });
    return new Engine(page);
  }

  async send(jobId, kind, files, options) {
    const { page } = this;
    await page.evaluate(([id, k, o]) => window.engine.begin(id, k, o), [jobId, kind, options]);
    for (const buf of files) {
      await page.evaluate((id) => window.engine.mark(id), jobId);
      for (let off = 0; off < buf.length; off += CHUNK) {
        await page.evaluate(([id, b]) => window.engine.chunk(id, b), [jobId, buf.subarray(off, off + CHUNK).toString('base64')]);
      }
    }
    // Not awaited inside the page: end() resolves only after the OCR gate is answered.
    await page.evaluate((id) => {
      window.engine.end(id);
    }, jobId);
  }

  async waitFor(jobId, types) {
    await this.page.waitForFunction(
      ([id, t]) => window.__msgs.some((m) => m.jobId === id && t.includes(m.type)),
      [jobId, types],
      { timeout: 300000 },
    );
  }

  async loadOcr() {
    if (this.ocrLoaded) return;
    for (const name of ['core', 'worker', 'tur', 'eng']) {
      const id = `asset-${name}`;
      await this.send(id, `asset:${name}`, [readFileSync(join(root, 'assets/ocr', `${name}.bin`))]);
      await this.waitFor(id, ['done']);
    }
    this.ocrLoaded = true;
  }

  // Extracts a book; OCR is granted only when `ocr` is true, mirroring the app's answer to "ocrNeeded".
  async extract(kind, files, { ocr = false, ...options } = {}) {
    const jobId = `job${this.n++}`;
    await this.send(jobId, kind, files, options);
    await this.waitFor(jobId, ['done', 'error', 'ocrNeeded']);
    if (await this.page.evaluate((id) => window.__msgs.some((m) => m.jobId === id && m.type === 'ocrNeeded'), jobId)) {
      if (ocr) await this.loadOcr();
      await this.page.evaluate(([id, ok]) => window.engine.ocrStart(id, ok), [jobId, ocr]);
      await this.waitFor(jobId, ['done', 'error']);
    }
    const msgs = await this.page.evaluate((id) => window.__msgs.filter((m) => m.jobId === id && m.type !== 'ack'), jobId);
    const sections = new Map();
    for (const m of msgs) if (m.type === 'section') sections.set(m.index, m);
    return {
      ocrOrder: msgs.filter((m) => m.type === 'section' && m.ocr).map((m) => m.index),
      end: msgs.find((m) => m.type === 'done' || m.type === 'error'),
      meta: msgs.find((m) => m.type === 'meta'),
      sections: [...sections.keys()].sort((a, b) => a - b).map((k) => sections.get(k)),
    };
  }
}

for (const [name, launch] of engines) {
  let browser;
  let engine;

  before(async () => {
    browser = await launch();
    engine = await Engine.open(browser);
  });

  after(async () => {
    await browser?.close();
  });

  test(`${name}: PDF text without running headers/footers`, async () => {
    const r = await engine.extract('pdf', [fixture('mavi-defter.pdf')]);
    assert.equal(r.end.type, 'done');
    assert.equal(r.meta.title, 'Mavi Defter');
    assert.equal(r.sections.length, 3);
    assert.match(r.sections[0].text, /Elif adında meraklı bir kız/);
    assert.doesNotMatch(r.sections.map((s) => s.text).join('\n'), /Mavi Defter/);
    // Page 2 is blank apart from the footer and has no image, so it is not sent to OCR.
    assert.equal(r.sections[1].needsOcr, false);
    assert.equal(r.sections[1].text, '');
  });

  test(`${name}: EPUB chapters and metadata`, async () => {
    const r = await engine.extract('epub', [fixture('lighthouse.epub')]);
    assert.equal(r.meta.title, 'The Lighthouse Keeper');
    assert.equal(r.meta.language, 'en');
    assert.deepEqual(r.sections.map((s) => s.title), ['Chapter One', 'Chapter Two']);
  });

  test(`${name}: DOCX split at headings`, async () => {
    const r = await engine.extract('docx', [fixture('notlar.docx')]);
    assert.equal(r.meta.title, 'Kütüphane Notları');
    assert.deepEqual(r.sections.map((s) => s.title), ['Birinci Bölüm', 'İkinci Bölüm']);
  });

  test(`${name}: Kindle AZW3 with chapter titles`, async () => {
    const r = await engine.extract('mobi', [fixture('alice-gutenberg.azw3')]);
    assert.equal(r.meta.title, "Alice's Adventures in Wonderland");
    assert.equal(r.sections.length, 19);
    assert.equal(r.sections[4].title, 'CHAPTER I. Down the Rabbit-Hole');
    assert.match(r.sections[4].text, /Alice was beginning to get very tired/);
  });

  test(`${name}: plain text`, async () => {
    const r = await engine.extract('txt', [fixture('masal.txt')]);
    assert.match(r.sections[0].text, /Elif her sabah kütüphaneye gider/);
  });

  test(`${name}: scanned PDF is read with offline OCR`, async () => {
    const r = await engine.extract('pdf', [fixture('taranmis.pdf')], { ocr: true });
    assert.equal(r.end.type, 'done');
    assert.match(r.sections[0].text, /Elif adında meraklı bir kız yaşarmış/);
    assert.match(r.sections[1].text, /kapağında yıldızlar olan mavi bir defter/);
  });

  // Scanners save pages as CCITT/JBIG2 bilevel or JPEG 2000 images, which pdf.js decodes with bundled WebAssembly.
  test(`${name}: scanned book with CCITT and JPEG 2000 page images`, async () => {
    const r = await engine.extract('pdf', [fixture('taranmis-kitap.pdf')], { ocr: true });
    assert.equal(r.end.type, 'done');
    assert.match(r.sections[0].text, /a wet cat walked in through the door/);
    assert.match(r.sections[1].text, /knew her name: Cotton/);
    assert.match(r.sections[2].text, /kasabanın ışıklarının birer birer yanışını/);
  });

  // Phone WebViews can refuse to start a decoder's WebAssembly; pdf.js then needs the bundled JavaScript builds.
  test(`${name}: scanned pages still decode when the WebAssembly decoders cannot start`, async () => {
    const fresh = await Engine.open(browser);
    try {
      await fresh.page.evaluate(() => {
        globalThis.__pdfWasm = {};
      });
      const r = await fresh.extract('pdf', [fixture('taranmis-kitap.pdf')], { ocr: true });
      assert.equal(r.end.type, 'done');
      assert.match(r.sections[0].text, /a wet cat walked in through the door/);
      assert.match(r.sections[2].text, /kasabanın ışıklarının birer birer yanışını/);
    } finally {
      await fresh.page.close();
    }
  });

  test(`${name}: OCR starts at the page being read and skips pages already recognised`, async () => {
    const r = await engine.extract('pdf', [fixture('taranmis-kitap.pdf')], { ocr: true, focus: 1, skip: [2] });
    assert.equal(r.end.type, 'done');
    assert.deepEqual(r.ocrOrder, [1, 0]);
    assert.deepEqual(r.sections.map((s) => s.index), [0, 1]);
  });

  test(`${name}: page photo becomes text`, async () => {
    const r = await engine.extract('images', [fixture('sayfa-foto.jpg')], { ocr: true });
    assert.match(r.sections[0].text, /tozlu bir rafın arkasında/);
  });

  test(`${name}: corrupt PDF reports a readable error`, async () => {
    const r = await engine.extract('pdf', [Buffer.from('not a pdf')]);
    assert.equal(r.end.type, 'error');
    assert.match(r.end.message, /PDF/);
  });
}
