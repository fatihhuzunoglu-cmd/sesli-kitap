// Searches free, legal book sources on the internet. Shared by the phone app and the computer app, so it only uses fetch.
//  - LibriVox: public-domain audiobooks read by volunteers (served from the Internet Archive's librivoxaudio collection).
//  - Internet Archive: other audiobooks whose uploader published them under an open licence.
//  - Project Gutenberg (through the Gutendex API): public-domain e-books, read aloud by the app's voices.

export type CatalogSource = 'librivox' | 'archive' | 'gutenberg';
export type CatalogKind = 'audio' | 'ebook';

export type CatalogItem = {
  source: CatalogSource;
  kind: CatalogKind;
  id: string;
  title: string;
  author: string | null;
  // ISO 639-1 where known ('tr', 'en'), otherwise what the source said.
  language: string | null;
  // Short extra line: running time of an audiobook, or the licence an uploader declared.
  detail: string | null;
  // E-books: the file to download and its type.
  url?: string;
  format?: 'epub' | 'txt';
};

export type AudioTrack = { title: string; url: string; seconds: number | null };
export type AudioBookInfo = { title: string; author: string | null; language: string | null; tracks: AudioTrack[] };

export type CatalogBases = { archive: string; gutendex: string };
export const DEFAULT_BASES: CatalogBases = { archive: 'https://archive.org', gutendex: 'https://gutendex.com' };

type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const SOURCE_LABEL: Record<CatalogSource, string> = {
  librivox: 'LibriVox',
  archive: 'Internet Archive',
  gutenberg: 'Project Gutenberg',
};

export class CatalogError extends Error {}

const ISO3: Record<string, string> = {
  tur: 'tr', turkish: 'tr', eng: 'en', english: 'en', ger: 'de', deu: 'de', german: 'de', fre: 'fr', fra: 'fr', french: 'fr',
  spa: 'es', spanish: 'es', ita: 'it', italian: 'it', por: 'pt', portuguese: 'pt', dut: 'nl', nld: 'nl', dutch: 'nl',
  rus: 'ru', russian: 'ru', ara: 'ar', arabic: 'ar',
};

export function normaliseLanguage(value: unknown): string | null {
  const v = (Array.isArray(value) ? value[0] : value) as string | undefined;
  if (!v || typeof v !== 'string') return null;
  const k = v.trim().toLowerCase();
  return ISO3[k] ?? (k.length === 2 ? k : v.trim());
}

function first(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Keeps letters, digits and spaces: the Internet Archive query language treats most punctuation as syntax.
export function cleanQuery(q: string) {
  return q.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

async function getJson(fetchFn: FetchFn, url: string, what: string) {
  let res;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new CatalogError(`${what} sitesine ulaşılamadı. İnternet bağlantınızı kontrol edin.`);
  }
  if (!res.ok) throw new CatalogError(`${what} şu an yanıt vermiyor (hata ${res.status}). Biraz sonra yeniden deneyin.`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new CatalogError(`${what} anlaşılmayan bir yanıt verdi.`);
  }
}

type ArchiveDoc = { identifier: string; title?: unknown; creator?: unknown; language?: unknown; runtime?: unknown; licenseurl?: unknown };

function licenceLabel(url: string | null) {
  if (!url) return null;
  if (/publicdomain/i.test(url)) return 'Kamu malı';
  const cc = url.match(/licenses\/([a-z-]+)/i);
  return cc ? `CC ${cc[1].toUpperCase()} (yükleyenin beyanı)` : 'Açık lisans (yükleyenin beyanı)';
}

async function searchArchive(source: 'librivox' | 'archive', q: string, turkishOnly: boolean, fetchFn: FetchFn, bases: CatalogBases): Promise<CatalogItem[]> {
  const terms = `(title:(${q}) OR creator:(${q}) OR subject:(${q}))`;
  const scope =
    source === 'librivox'
      ? 'collection:(librivoxaudio)'
      : 'mediatype:(audio) AND licenseurl:* AND -collection:(librivoxaudio) AND (subject:(audiobook OR audiobooks OR "sesli kitap" OR "sesli kitaplar") OR collection:(audio_bookspoetry))';
  const lang = turkishOnly ? ' AND language:(tur OR turkish OR Türkçe)' : '';
  const params = ['identifier', 'title', 'creator', 'language', 'runtime', 'licenseurl'].map((f) => `fl[]=${f}`).join('&');
  const url = `${bases.archive}/advancedsearch.php?q=${encodeURIComponent(`${terms} AND ${scope}${lang}`)}&${params}&sort[]=downloads+desc&rows=25&output=json`;
  const json = await getJson(fetchFn, url, 'Internet Archive');
  const docs = ((json.response as { docs?: ArchiveDoc[] } | undefined)?.docs ?? []).filter((d) => d && typeof d.identifier === 'string');
  return docs.map((d) => ({
    source,
    kind: 'audio' as const,
    id: d.identifier,
    title: first(d.title) ?? d.identifier,
    author: first(d.creator),
    language: normaliseLanguage(d.language),
    detail: source === 'librivox' ? (first(d.runtime) ? `${first(d.runtime)} · kamu malı` : 'Kamu malı') : licenceLabel(first(d.licenseurl)),
  }));
}

type GutenbergBook = { id: number; title?: string; authors?: { name?: string }[]; languages?: string[]; copyright?: boolean | null; formats?: Record<string, string> };

// Gutenberg lists authors as "Carroll, Lewis".
function authorName(name: string | undefined) {
  if (!name) return null;
  const [last, firstName] = name.split(/,\s*/);
  return firstName ? `${firstName} ${last}` : last;
}

async function searchGutenberg(q: string, turkishOnly: boolean, fetchFn: FetchFn, bases: CatalogBases): Promise<CatalogItem[]> {
  const url = `${bases.gutendex}/books/?search=${encodeURIComponent(q)}${turkishOnly ? '&languages=tr' : ''}`;
  const json = await getJson(fetchFn, url, 'Project Gutenberg');
  const items: CatalogItem[] = [];
  for (const b of (json.results as GutenbergBook[] | undefined) ?? []) {
    if (b.copyright) continue;
    const formats = b.formats ?? {};
    const epub = formats['application/epub+zip'];
    const txt = Object.entries(formats).find(([type, link]) => type.startsWith('text/plain') && !link.endsWith('.zip'))?.[1];
    if (!epub && !txt) continue;
    items.push({
      source: 'gutenberg',
      kind: 'ebook',
      id: String(b.id),
      title: b.title ?? `Gutenberg ${b.id}`,
      author: authorName(b.authors?.[0]?.name),
      language: normaliseLanguage(b.languages),
      detail: 'Kamu malı e-kitap · uygulamanın sesiyle okunur',
      url: epub ?? txt,
      format: epub ? 'epub' : 'txt',
    });
  }
  return items;
}

// Searches one kind of book. Audiobooks come from LibriVox and the Internet Archive; a source that fails is
// skipped as long as the other one answers.
export async function searchCatalog(
  query: string,
  opts: { kind: CatalogKind; turkishOnly?: boolean },
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  bases: CatalogBases = DEFAULT_BASES,
): Promise<CatalogItem[]> {
  const q = cleanQuery(query);
  if (q.length < 2) throw new CatalogError('Aramak için en az iki harf yazın.');
  const turkishOnly = !!opts.turkishOnly;
  if (opts.kind === 'ebook') return searchGutenberg(q, turkishOnly, fetchFn, bases);
  const results = await Promise.allSettled([
    searchArchive('librivox', q, turkishOnly, fetchFn, bases),
    searchArchive('archive', q, turkishOnly, fetchFn, bases),
  ]);
  const ok = results.filter((r): r is PromiseFulfilledResult<CatalogItem[]> => r.status === 'fulfilled');
  if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
  return ok.flatMap((r) => r.value);
}

// "867.21" (seconds) or "14:27" / "1:02:03".
export function parseLength(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((acc, part) => acc * 60 + parseInt(part, 10), 0);
  return null;
}

type ArchiveFile = { name: string; format?: string; title?: string; track?: string; length?: string; source?: string };

function trackNumber(f: ArchiveFile) {
  const n = parseInt(f.track ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

// The chapters of an Internet Archive audiobook, in order. Items usually hold each chapter in several encodings;
// the 64 kbps MP3s are half the size and plenty for speech, so those are preferred.
export function archiveTracks(base: string, identifier: string, files: ArchiveFile[]): AudioTrack[] {
  const mp3 = files.filter((f) => typeof f.name === 'string' && /\.mp3$/i.test(f.name));
  const preferred = ['64Kbps MP3', 'VBR MP3', '128Kbps MP3'];
  let chosen: ArchiveFile[] = [];
  for (const format of preferred) {
    chosen = mp3.filter((f) => f.format === format);
    if (chosen.length) break;
  }
  if (!chosen.length) chosen = mp3.filter((f) => f.source !== 'derivative');
  if (!chosen.length) chosen = mp3;
  // Derived 64 kbps files carry no track number; take it from the original they were made from.
  const originals = new Map(mp3.filter((f) => trackNumber(f) !== null).map((f) => [f.name.replace(/\.mp3$/i, ''), trackNumber(f)!]));
  const order = (f: ArchiveFile) => trackNumber(f) ?? originals.get(f.name.replace(/(_64kb)?\.mp3$/i, '')) ?? null;
  const sorted = [...chosen].sort((a, b) => {
    const na = order(a);
    const nb = order(b);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return sorted.map((f, i) => ({
    title: f.title?.trim() || `Bölüm ${i + 1}`,
    url: `${base}/download/${encodeURIComponent(identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
    seconds: parseLength(f.length),
  }));
}

export async function audioBookInfo(item: Pick<CatalogItem, 'id'>, fetchFn: FetchFn = fetch as unknown as FetchFn, bases: CatalogBases = DEFAULT_BASES): Promise<AudioBookInfo> {
  const json = await getJson(fetchFn, `${bases.archive}/metadata/${encodeURIComponent(item.id)}`, 'Internet Archive');
  const meta = (json.metadata ?? {}) as Record<string, unknown>;
  const tracks = archiveTracks(bases.archive, item.id, (json.files as ArchiveFile[] | undefined) ?? []);
  if (!tracks.length) throw new CatalogError('Bu kayıtta dinlenebilir ses dosyası (MP3) yok.');
  return { title: first(meta.title) ?? item.id, author: first(meta.creator), language: normaliseLanguage(meta.language), tracks };
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
