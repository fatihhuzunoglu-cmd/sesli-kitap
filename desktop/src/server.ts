// The computer app's web server. It serves the app's own window (from this computer only) and, to paired phones on
// the home network, the library: ready-made books (.skitap) and downloaded audiobooks. Phones send books back too.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import QRCode from 'qrcode';
import { audioBookInfo, DEFAULT_BASES, searchCatalog, type CatalogBases, type CatalogItem } from '../../src/lib/catalog';
import { PACKAGE_EXTENSION, packageFileName, parsePackage } from '../../src/lib/bookPackage';
import { pcQrText, type PcItem } from '../../src/lib/pcLink';

export type ServerOptions = {
  port: number;
  host?: string;
  libraryDir: string;
  staticDir: string;
  version: string;
  // Fixed pairing code (tests); otherwise one is made once and kept in the library folder.
  token?: string;
  // Requests from this computer itself are trusted without the code (the app's own window). Tests turn it off.
  trustLoopback?: boolean;
  catalogBases?: CatalogBases;
  log?: (line: string) => void;
};

type Meta = {
  id: string;
  kind: 'book' | 'audio';
  title: string;
  author: string | null;
  language: string | null;
  status: 'ready' | 'downloading' | 'error';
  error?: string | null;
  addedAt: number;
  // Books: number of pages/chapters. Audiobooks: their chapters and how many are downloaded.
  count: number;
  tracks?: { title: string; file: string; seconds: number | null; url: string }[];
  downloaded?: number;
  size: number;
  source?: string;
};

const MAX_UPLOAD = 300 * 1024 * 1024;
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newToken() {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => TOKEN_CHARS[b % TOKEN_CHARS.length]).join('');
}

function newId() {
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

// Addresses a phone on the same network can reach, the most likely home-network one first.
export function lanAddresses() {
  const out: { name: string; address: string; score: number }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (/^192\.168\./.test(a.address)) score += 3;
      else if (/^10\./.test(a.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      if (/wi-?fi|wlan|wireless|kablosuz/i.test(name)) score += 2;
      if (/ethernet/i.test(name) && !/vethernet/i.test(name)) score += 1;
      if (/vethernet|virtualbox|vmware|wsl|hyper-v|docker|vpn|tailscale|zerotier|bluetooth|loopback/i.test(name)) score -= 10;
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((x, y) => y.score - x.score).map(({ name, address }) => ({ name, address }));
}

function isLoopback(req: IncomingMessage) {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req: IncomingMessage, limit = MAX_UPLOAD): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Dosya çok büyük.'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  bin: 'application/octet-stream',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

// Serves a file, honouring a byte range: iPhones only stream audio from servers that answer ranges.
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, extraHeaders: Record<string, string> = {}) {
  if (!existsSync(file)) return sendJson(res, 404, { error: 'Dosya bulunamadı.' });
  const size = statSync(file).size;
  const ext = file.split('.').pop()!.toLowerCase();
  const headers: Record<string, string | number> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', ...extraHeaders };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

export class Library {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private metaFile(id: string) {
    return join(this.dir, id, 'meta.json');
  }

  get(id: string): Meta | null {
    if (!/^[a-z0-9]+$/i.test(id)) return null;
    try {
      return JSON.parse(readFileSync(this.metaFile(id), 'utf8')) as Meta;
    } catch {
      return null;
    }
  }

  save(meta: Meta) {
    mkdirSync(join(this.dir, meta.id), { recursive: true });
    const tmp = `${this.metaFile(meta.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, this.metaFile(meta.id));
  }

  list(): Meta[] {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.get(d.name))
      .filter((m): m is Meta => !!m)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  path(id: string, file: string) {
    return join(this.dir, id, file);
  }

  remove(id: string) {
    if (this.get(id)) rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  addPackage(json: string, source: string): Meta {
    const pkg = parsePackage(json);
    const id = newId();
    const meta: Meta = {
      id,
      kind: 'book',
      title: pkg.title,
      author: pkg.author,
      language: pkg.language,
      status: 'ready',
      addedAt: Date.now(),
      count: pkg.sections.length,
      size: Buffer.byteLength(json),
      source,
    };
    mkdirSync(join(this.dir, id), { recursive: true });
    writeFileSync(this.path(id, `book.${PACKAGE_EXTENSION}`), json);
    this.save(meta);
    return meta;
  }
}

function toItem(m: Meta): PcItem {
  return { id: m.id, kind: m.kind, title: m.title, author: m.author, language: m.language, count: m.count, size: m.size, status: m.status };
}

function extOf(url: string) {
  return url.split(/[?#]/)[0].match(/\.(mp3|m4a|m4b|aac|ogg|opus|wav|flac)$/i)?.[1].toLowerCase() ?? 'mp3';
}

export async function startServer(opts: ServerOptions) {
  const log = opts.log ?? (() => {});
  const library = new Library(opts.libraryDir);
  const bases = opts.catalogBases ?? DEFAULT_BASES;
  const trustLoopback = opts.trustLoopback ?? true;
  const tokenFile = join(opts.libraryDir, '.baglanti-kodu');
  let token = opts.token ?? (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
  if (!token) {
    token = newToken();
    writeFileSync(tokenFile, token);
  }
  const staticDir = resolve(opts.staticDir);
  const engineHtml = () => {
    const html = readFileSync(join(staticDir, 'engine.html'), 'utf8');
    // The engine was written for the phone's WebView; inside this window it reports to the page that framed it.
    const shim = '<script>window.ReactNativeWebView={postMessage:function(m){parent.postMessage(m,"*")}};</script>';
    return html.replace('<head>', `<head>${shim}`);
  };

  // Audiobooks are downloaded chapter by chapter in the background; the window shows the progress from the library.
  const downloading = new Set<string>();
  const downloadAudio = async (id: string) => {
    if (downloading.has(id)) return;
    downloading.add(id);
    try {
      let meta = library.get(id);
      if (!meta?.tracks) return;
      let failed = 0;
      for (const track of meta.tracks) {
        const file = library.path(id, track.file);
        if (existsSync(file)) continue;
        try {
          const res = await fetch(track.url);
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${file}.part`));
          renameSync(`${file}.part`, file);
        } catch (e) {
          failed++;
          log(`indirilemedi ${track.url}: ${(e as Error).message}`);
          rmSync(`${file}.part`, { force: true });
        }
        meta = library.get(id);
        if (!meta?.tracks) return;
        meta.downloaded = meta.tracks.filter((t) => existsSync(library.path(id, t.file))).length;
        meta.size = meta.tracks.reduce((sum, t) => sum + (existsSync(library.path(id, t.file)) ? statSync(library.path(id, t.file)).size : 0), 0);
        library.save(meta);
      }
      meta = library.get(id);
      if (!meta) return;
      meta.status = failed ? 'error' : 'ready';
      meta.error = failed ? `${failed} bölüm indirilemedi. İnternet bağlantısını kontrol edip “Yeniden dene”ye basın.` : null;
      library.save(meta);
    } finally {
      downloading.delete(id);
    }
  };
  // Downloads cut short when the app closed carry on.
  for (const m of library.list()) if (m.kind === 'audio' && m.status === 'downloading') void downloadAudio(m.id);

  const addAudio = async (item: Pick<CatalogItem, 'id' | 'title' | 'author'>) => {
    const info = await audioBookInfo(item, fetch as never, bases);
    const id = newId();
    const tracks = info.tracks.map((t, i) => ({ title: t.title, seconds: t.seconds, url: t.url, file: `${String(i + 1).padStart(4, '0')}.${extOf(t.url)}` }));
    const meta: Meta = {
      id,
      kind: 'audio',
      title: info.title || item.title,
      author: info.author ?? item.author ?? null,
      language: info.language,
      status: 'downloading',
      addedAt: Date.now(),
      count: tracks.length,
      tracks,
      downloaded: 0,
      size: 0,
    };
    library.save(meta);
    void downloadAudio(id);
    return meta;
  };

  const pairing = async (preferred?: string) => {
    const addresses = lanAddresses();
    const address = addresses.find((a) => a.address === preferred)?.address ?? addresses[0]?.address ?? '127.0.0.1';
    const link = { url: `http://${address}:${port}`, token, name: hostname() };
    const text = pcQrText(link);
    return { token, port, address, addresses, link: text, name: link.name, qr: await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const local = trustLoopback && isLoopback(req);
    const authorised = local || url.searchParams.get('t')?.toUpperCase() === token;

    // The app's own window: this computer only.
    if (!path.startsWith('/api/')) {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'Bu sayfa yalnızca bilgisayarın kendisinden açılır.' });
      if (path === '/' || path === '/index.html') return sendFile(req, res, join(staticDir, 'index.html'));
      if (path === '/engine.html') {
        const html = Buffer.from(engineHtml());
        res.writeHead(200, { 'Content-Type': MIME.html, 'Content-Length': html.length });
        return void res.end(html);
      }
      const file = resolve(staticDir, `.${path}`);
      if (!file.startsWith(staticDir)) return sendJson(res, 403, { error: 'Yasak.' });
      return sendFile(req, res, file);
    }

    if (!authorised) return sendJson(res, 401, { error: 'Bağlantı kodu geçersiz.' });
    const parts = path.split('/').filter(Boolean).slice(1);

    // --- For paired phones (and the window) ---
    if (req.method === 'GET' && path === '/api/info') return sendJson(res, 200, { app: 'seslikitap-pc', name: hostname(), version: opts.version });
    if (req.method === 'GET' && path === '/api/library') return sendJson(res, 200, { items: library.list().map(toItem) });
    if (parts[0] === 'library' && parts[1]) {
      const meta = library.get(parts[1]);
      if (!meta) return sendJson(res, 404, { error: 'Bu kitap bilgisayarda artık yok.' });
      if ((req.method === 'GET' || req.method === 'HEAD') && parts[2] === 'package' && meta.kind === 'book') {
        const headers: Record<string, string> = url.searchParams.has('download')
          ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(packageFileName(meta.title))}` }
          : {};
        return sendFile(req, res, library.path(meta.id, `book.${PACKAGE_EXTENSION}`), headers);
      }
      if (req.method === 'GET' && parts[2] === 'audio' && meta.kind === 'audio') {
        return sendJson(res, 200, {
          title: meta.title,
          author: meta.author,
          language: meta.language,
          tracks: (meta.tracks ?? []).map((t, i) => ({ title: t.title, seconds: t.seconds, url: `/api/library/${meta.id}/track/${i}` })),
        });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && parts[2] === 'track' && meta.tracks) {
        const track = meta.tracks[parseInt(parts[3] ?? '', 10)];
        if (!track) return sendJson(res, 404, { error: 'Bölüm yok.' });
        const file = library.path(meta.id, track.file);
        // A chapter not downloaded yet is passed on from where it is being downloaded.
        if (!existsSync(file)) {
          res.writeHead(302, { Location: track.url });
          return void res.end();
        }
        return sendFile(req, res, file);
      }
    }
    if (req.method === 'POST' && path === '/api/upload') {
      const body = await readBody(req);
      try {
        const meta = library.addPackage(body.toString('utf8'), local ? 'bilgisayar' : 'telefon');
        log(`eklendi: ${meta.title} (${meta.count} bölüm, ${local ? 'bu bilgisayar' : 'telefon'})`);
        return sendJson(res, 200, { id: meta.id });
      } catch (e) {
        return sendJson(res, 400, { error: (e as Error).message });
      }
    }

    // --- The window only ---
    if (!local) return sendJson(res, 403, { error: 'Bu işlem yalnızca bilgisayardan yapılır.' });
    if (req.method === 'GET' && path === '/api/pair') return sendJson(res, 200, await pairing(url.searchParams.get('address') ?? undefined));
    if (req.method === 'DELETE' && parts[0] === 'library' && parts[1]) {
      library.remove(parts[1]);
      return sendJson(res, 200, {});
    }
    if (req.method === 'POST' && parts[0] === 'library' && parts[2] === 'retry') {
      const meta = library.get(parts[1]);
      if (meta?.kind === 'audio') {
        library.save({ ...meta, status: 'downloading', error: null });
        void downloadAudio(meta.id);
      }
      return sendJson(res, 200, {});
    }
    if (req.method === 'GET' && path === '/api/search') {
      try {
        const items = await searchCatalog(
          url.searchParams.get('q') ?? '',
          { kind: url.searchParams.get('kind') === 'ebook' ? 'ebook' : 'audio', turkishOnly: url.searchParams.get('tr') === '1' },
          fetch as never,
          bases,
        );
        return sendJson(res, 200, { items });
      } catch (e) {
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }
    if (req.method === 'POST' && path === '/api/download') {
      const item = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')) as CatalogItem;
      try {
        return sendJson(res, 200, { id: (await addAudio(item)).id });
      } catch (e) {
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }
    // E-books found online are fetched here (browsers may not fetch other sites) and converted in the window.
    if (req.method === 'GET' && path === '/api/fetch') {
      const target = url.searchParams.get('url') ?? '';
      if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { error: 'Geçersiz adres.' });
      try {
        const r = await fetch(target, { redirect: 'follow' });
        if (!r.ok) return sendJson(res, 502, { error: `Dosya indirilemedi (hata ${r.status}).` });
        const data = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
        return void res.end(data);
      } catch {
        return sendJson(res, 502, { error: 'Dosya indirilemedi. İnternet bağlantısını kontrol edin.' });
      }
    }
    return sendJson(res, 404, { error: 'Bilinmeyen istek.' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`hata: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
      else res.destroy();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  // The usual port may be taken (another copy, another program): try the next few.
  let port = opts.port;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(port, opts.host ?? '0.0.0.0', () => {
          server.off('error', fail);
          ok();
        });
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 10) throw e;
      port++;
    }
  }
  log(`Sesli Kitap sunucusu: http://127.0.0.1:${port} (kod ${token}, kitaplık ${opts.libraryDir})`);

  return {
    port,
    token,
    library,
    pairing,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
