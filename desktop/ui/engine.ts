// Drives the phone app's extraction engine (PDF, EPUB, Kindle, Word, photos + OCR) inside a hidden frame of this
// window, so a book converted here reads exactly as it would have on the phone, only faster.

type Msg = { type: string; jobId?: string; [k: string]: unknown };
type EngineApi = {
  begin(id: string, kind: string, options: object): void;
  mark(id: string): void;
  chunk(id: string, b64: string): void;
  end(id: string): void;
  ocrStart(id: string, ok: boolean): void;
  cancel(id: string): void;
};

export type ConvertedSection = { title: string; text: string; empty: boolean };
export type Converted = { title: string | null; author: string | null; language: string | null; sections: ConvertedSection[] };
export type Progress = { text: string; fraction: number | null };

const CHUNK = 512 * 1024;
const OCR_ASSETS = ['core', 'worker', 'tur', 'eng'];

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export class Engine {
  private frame: HTMLIFrameElement;
  private ready: Promise<void>;
  private handlers = new Map<string, (m: Msg) => void>();
  private ocrLoaded: Promise<void> | null = null;
  private n = 0;
  current: string | null = null;

  constructor() {
    this.frame = document.createElement('iframe');
    this.frame.src = '/engine.html';
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.style.cssText = 'position:absolute;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0';
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    window.addEventListener('message', (e) => {
      if (e.source !== this.frame.contentWindow || typeof e.data !== 'string') return;
      const m = JSON.parse(e.data) as Msg;
      if (m.type === 'ready') resolveReady();
      else if (m.type === 'log') console.warn('[engine]', m.message);
      else if (m.jobId) this.handlers.get(m.jobId)?.(m);
    });
    document.body.append(this.frame);
  }

  private get api() {
    return (this.frame.contentWindow as unknown as { engine: EngineApi }).engine;
  }

  private async send(jobId: string, kind: string, files: Uint8Array[], markEach: boolean) {
    const api = this.api;
    api.begin(jobId, kind, {});
    for (const bytes of files) {
      if (markEach) api.mark(jobId);
      for (let off = 0; off < bytes.length; off += CHUNK) {
        api.chunk(jobId, toBase64(bytes.subarray(off, off + CHUNK)));
        if ((off / CHUNK) % 8 === 7) await tick();
      }
    }
    void api.end(jobId);
  }

  private loadOcr() {
    if (!this.ocrLoaded) {
      this.ocrLoaded = (async () => {
        for (const name of OCR_ASSETS) {
          const res = await fetch(`/ocr/${name}.bin`);
          if (!res.ok) throw new Error('Metin tanıma (OCR) dosyaları bulunamadı.');
          const bytes = new Uint8Array(await res.arrayBuffer());
          const id = `asset-${name}-${this.n++}`;
          const done = new Promise<void>((resolve) => this.handlers.set(id, (m) => m.type === 'done' && resolve()));
          await this.send(id, `asset:${name}`, [bytes], false);
          await done;
          this.handlers.delete(id);
        }
      })();
      this.ocrLoaded.catch(() => (this.ocrLoaded = null));
    }
    return this.ocrLoaded;
  }

  cancel() {
    if (this.current) this.api.cancel(this.current);
  }

  // kind: the engine's format name ('pdf', 'epub', 'images', …). Photo books pass one file per page.
  async convert(kind: string, files: Uint8Array[], onProgress: (p: Progress) => void): Promise<Converted> {
    await this.ready;
    const jobId = `job-${this.n++}`;
    const sections = new Map<number, ConvertedSection>();
    let meta: Converted = { title: null, author: null, language: null, sections: [] };
    let count = 0;
    let cancelled = false;
    this.current = jobId;
    onProgress({ text: 'Dosya açılıyor…', fraction: null });
    try {
      await new Promise<void>((resolve, reject) => {
        this.handlers.set(jobId, (m) => {
          switch (m.type) {
            case 'meta':
              meta = { ...meta, title: (m.title as string) || null, author: (m.author as string) || null, language: (m.language as string) || null };
              count = m.sectionCount as number;
              onProgress({ text: `${count} sayfa/bölüm okunuyor…`, fraction: 0 });
              break;
            case 'section': {
              const text = String(m.text ?? '');
              sections.set(m.index as number, { title: String(m.title ?? ''), text, empty: !text.trim() });
              if (!m.ocr && count) onProgress({ text: `Okunuyor… ${sections.size}/${count}`, fraction: sections.size / count });
              break;
            }
            case 'ocrNeeded':
              onProgress({ text: `${m.count} taranmış sayfa var; metin tanıma hazırlanıyor…`, fraction: null });
              this.loadOcr().then(
                () => this.api.ocrStart(jobId, true),
                () => this.api.ocrStart(jobId, false),
              );
              break;
            case 'ocrProgress':
              onProgress({ text: `Taranmış sayfalar tanınıyor… ${m.done}/${m.total}`, fraction: (m.done as number) / Math.max(1, m.total as number) });
              break;
            case 'done':
              resolve();
              break;
            case 'cancelled':
              cancelled = true;
              resolve();
              break;
            case 'error':
              reject(new Error(String(m.message)));
              break;
          }
        });
        this.send(jobId, kind, files, kind === 'images').catch(reject);
      });
    } finally {
      this.handlers.delete(jobId);
      this.current = null;
    }
    if (cancelled) throw new Error('Dönüştürme durduruldu.');
    const total = Math.max(count, ...[...sections.keys()].map((k) => k + 1));
    for (let i = 0; i < total; i++) meta.sections.push(sections.get(i) ?? { title: `Sayfa ${i + 1}`, text: '', empty: true });
    return meta;
  }
}
