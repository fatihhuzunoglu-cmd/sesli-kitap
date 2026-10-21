// A ".skitap" file is a book whose text has already been extracted (and OCR'd), so a phone can open it at once.
// The computer app makes them from scanned PDFs and photos; the phone app exports them to share a book.
// It is plain JSON (UTF-8):
//   { "type": "seslikitap", "version": 1, "title", "author", "language", "origin": "pdf", "sections": [{ "title", "text" }] }

export const PACKAGE_EXTENSION = 'skitap';
export const PACKAGE_MIME = 'application/x-seslikitap+json';

export type PackageSection = { title: string; text: string };
export type BookPackage = {
  type: 'seslikitap';
  version: 1;
  title: string;
  author: string | null;
  language: string;
  // Format of the book the text came from ('pdf', 'images', 'epub', …): pages or chapters.
  origin: string;
  sections: PackageSection[];
};

export class PackageError extends Error {}

export function buildPackage(p: Omit<BookPackage, 'type' | 'version'>): BookPackage {
  return { type: 'seslikitap', version: 1, ...p };
}

export function parsePackage(json: string): BookPackage {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
  } catch {
    throw new PackageError('Kitap paketi bozuk ya da yarım aktarılmış.');
  }
  if (!data || data.type !== 'seslikitap') throw new PackageError('Bu dosya bir Sesli Kitap paketi değil.');
  if (typeof data.version !== 'number' || data.version > 1) throw new PackageError('Bu paket daha yeni bir Sesli Kitap sürümüyle yapılmış; uygulamayı güncelleyin.');
  const sections = Array.isArray(data.sections) ? data.sections : null;
  if (!sections?.length) throw new PackageError('Kitap paketinde hiç sayfa yok.');
  return {
    type: 'seslikitap',
    version: 1,
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Adsız kitap',
    author: typeof data.author === 'string' && data.author.trim() ? data.author.trim() : null,
    language: typeof data.language === 'string' && data.language ? data.language : 'tr',
    origin: typeof data.origin === 'string' ? data.origin : 'txt',
    sections: sections.map((s: unknown, i) => {
      const sec = (s ?? {}) as Record<string, unknown>;
      return { title: typeof sec.title === 'string' && sec.title ? sec.title : `Bölüm ${i + 1}`, text: typeof sec.text === 'string' ? sec.text : '' };
    }),
  };
}

// File name for a package, safe on every system.
export function packageFileName(title: string) {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'kitap';
  return `${base}.${PACKAGE_EXTENSION}`;
}
