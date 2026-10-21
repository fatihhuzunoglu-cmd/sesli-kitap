import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveTracks, audioBookInfo, CatalogError, cleanQuery, parseLength, searchCatalog } from '../src/lib/catalog.ts';
import { buildPackage, packageFileName, PackageError, parsePackage } from '../src/lib/bookPackage.ts';
import { fromParams, parsePcLink, pcQrText, pcUrl } from '../src/lib/pcLink.ts';

const bases = { archive: 'https://ia.test', gutendex: 'https://gx.test' };

function fakeFetch(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const fn = async (url: string) => {
    urls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('{}', { status: 404 });
    const body = routes[key];
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fn, urls };
}

test('audiobook search asks LibriVox and openly licensed Internet Archive items, Turkish only on request', async () => {
  const { fn, urls } = fakeFetch({
    'mediatype%3A(audio)': { response: { docs: [{ identifier: 'masal_tr', title: ['Masallar'], creator: 'Okuyan', language: 'tur', licenseurl: 'https://creativecommons.org/licenses/by-sa/4.0/' }] } },
    advancedsearch: { response: { docs: [{ identifier: 'alice_lv', title: "Alice's Adventures", creator: 'Lewis Carroll', language: 'eng', runtime: '2:30:00' }] } },
  });
  const items = await searchCatalog('alice!', { kind: 'audio', turkishOnly: true }, fn, bases);
  assert.equal(urls.length, 2);
  for (const u of urls) assert.match(decodeURIComponent(u), /language:\(tur OR turkish/);
  assert.match(decodeURIComponent(urls[0]), /title:\(alice\)/);
  assert.deepEqual(
    items.map((i) => [i.source, i.id, i.language, i.detail]),
    [
      ['librivox', 'alice_lv', 'en', '2:30:00 · kamu malı'],
      ['archive', 'masal_tr', 'tr', 'CC BY-SA (yükleyenin beyanı)'],
    ],
  );
});

test('one failing audiobook source does not hide the other', async () => {
  const { fn } = fakeFetch({ 'mediatype%3A(audio)': new Error('offline'), advancedsearch: { response: { docs: [{ identifier: 'x', title: 'X' }] } } });
  assert.equal((await searchCatalog('xx', { kind: 'audio' }, fn, bases)).length, 1);
  const down = fakeFetch({});
  await assert.rejects(searchCatalog('xx', { kind: 'audio' }, down.fn, bases), CatalogError);
  await assert.rejects(searchCatalog(' ! ', { kind: 'audio' }, down.fn, bases), /en az iki harf/);
});

test('e-book search keeps public-domain Gutenberg books with an EPUB or plain text', async () => {
  const { fn, urls } = fakeFetch({
    '/books/': {
      results: [
        { id: 11, title: 'Alice', authors: [{ name: 'Carroll, Lewis' }], languages: ['en'], copyright: false, formats: { 'application/epub+zip': 'https://g/11.epub' } },
        { id: 12, title: 'Telifli', authors: [], languages: ['en'], copyright: true, formats: { 'application/epub+zip': 'https://g/12.epub' } },
        { id: 13, title: 'Düz metin', authors: [], languages: ['tr'], copyright: false, formats: { 'text/plain; charset=utf-8': 'https://g/13.txt', 'text/plain': 'https://g/13.zip' } },
        { id: 14, title: 'Dosyasız', authors: [], languages: ['en'], copyright: false, formats: { 'image/jpeg': 'https://g/14.jpg' } },
      ],
    },
  });
  const items = await searchCatalog('alice', { kind: 'ebook', turkishOnly: true }, fn, bases);
  assert.match(urls[0], /languages=tr/);
  assert.deepEqual(
    items.map((i) => [i.id, i.author, i.url, i.format]),
    [
      ['11', 'Lewis Carroll', 'https://g/11.epub', 'epub'],
      ['13', null, 'https://g/13.txt', 'txt'],
    ],
  );
});

test('chapters of an archive item: 64 kbps MP3s, in track order taken from the originals', () => {
  const files = [
    { name: 'b_02.mp3', format: 'VBR MP3', title: 'İkinci', track: '2/2', length: '61.5' },
    { name: 'b_01.mp3', format: 'VBR MP3', title: 'Birinci', track: '1/2', length: '120' },
    { name: 'b_02_64kb.mp3', format: '64Kbps MP3', title: 'İkinci', length: '1:01' },
    { name: 'b_01_64kb.mp3', format: '64Kbps MP3', title: 'Birinci', length: '2:00' },
    { name: 'cover.jpg', format: 'JPEG' },
  ];
  assert.deepEqual(archiveTracks('https://ia.test', 'kitap 1', files), [
    { title: 'Birinci', url: 'https://ia.test/download/kitap%201/b_01_64kb.mp3', seconds: 120 },
    { title: 'İkinci', url: 'https://ia.test/download/kitap%201/b_02_64kb.mp3', seconds: 61 },
  ]);
  assert.deepEqual(
    archiveTracks('https://ia.test', 'x', [{ name: 'only.mp3', format: 'MP3' }]).map((t) => t.title),
    ['Bölüm 1'],
  );
});

test('audiobook details and their errors', async () => {
  const { fn } = fakeFetch({ '/metadata/ok': { metadata: { title: 'Kitap', creator: ['Yazar'], language: 'tur' }, files: [{ name: 'a.mp3', format: 'VBR MP3', track: '1' }] }, '/metadata/empty': { metadata: {}, files: [] } });
  const info = await audioBookInfo({ id: 'ok' }, fn, bases);
  assert.deepEqual([info.title, info.author, info.language, info.tracks.length], ['Kitap', 'Yazar', 'tr', 1]);
  await assert.rejects(audioBookInfo({ id: 'empty' }, fn, bases), /MP3/);
});

test('small helpers', () => {
  assert.equal(cleanQuery(' Suç ve  Ceza: (roman)* '), 'Suç ve Ceza roman');
  assert.equal(parseLength('1:02:03'), 3723);
  assert.equal(parseLength('14:27'), 867);
  assert.equal(parseLength('867.6'), 868);
  assert.equal(parseLength('abc'), null);
});

test('book packages round-trip and reject other files', () => {
  const pkg = buildPackage({ title: 'Zengin Baba', author: null, language: 'tr', origin: 'pdf', sections: [{ title: 'Sayfa 1', text: 'Merhaba.' }] });
  const back = parsePackage('﻿' + JSON.stringify(pkg));
  assert.deepEqual(back, pkg);
  assert.throws(() => parsePackage('{"type":"other"}'), PackageError);
  assert.throws(() => parsePackage('{"type":"seslikitap","version":9,"sections":[{}]}'), /daha yeni/);
  assert.throws(() => parsePackage('{"type":"seslikitap","version":1,"sections":[]}'), /hiç sayfa/);
  assert.throws(() => parsePackage('{oops'), /bozuk/);
  assert.equal(parsePackage('{"type":"seslikitap","version":1,"sections":[{"text":5}]}').sections[0].title, 'Bölüm 1');
  assert.equal(packageFileName('Kitap: 1/2 *son*'), 'Kitap 1 2 son.skitap');
});

test('computer link: QR text, typed address and deep-link params', () => {
  const link = { url: 'http://192.168.1.20:47800', token: 'K7Q2MX', name: 'Ev PC' };
  const qr = pcQrText(link);
  assert.equal(qr, 'seslikitap://pc?u=http%3A%2F%2F192.168.1.20%3A47800&t=K7Q2MX&n=Ev%20PC');
  assert.deepEqual(parsePcLink(qr), link);
  assert.deepEqual(parsePcLink('192.168.1.20', 'k7q2mx '), { url: 'http://192.168.1.20:47800', token: 'K7Q2MX', name: null });
  assert.deepEqual(parsePcLink('http://10.0.0.5:9000/', 'A'), { url: 'http://10.0.0.5:9000', token: 'A', name: null });
  assert.equal(parsePcLink('192.168.1.20'), null);
  assert.equal(parsePcLink('https://example.com/a/b', 'X'), null);
  assert.equal(parsePcLink('seslikitap://pc?u=%E0&t=X'), null);
  assert.deepEqual(fromParams({ u: 'http://127.0.0.1:8001', t: 'e2e' }), { url: 'http://127.0.0.1:8001', token: 'E2E', name: null });
  assert.equal(fromParams({}), null);
  assert.equal(pcUrl(link, '/api/library'), 'http://192.168.1.20:47800/api/library?t=K7Q2MX');
  assert.equal(pcUrl(link, '/api/upload?name=a'), 'http://192.168.1.20:47800/api/upload?name=a&t=K7Q2MX');
});
