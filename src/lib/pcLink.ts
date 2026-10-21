// The link between the phone app and the computer app. The computer runs a small web server on the home network
// and shows a QR code holding its address and a pairing code:
//   seslikitap://pc?u=http%3A%2F%2F192.168.1.20%3A47800&t=K7Q2MX&n=Ev-PC
// Scanning it (with the app or the phone's camera) pairs the phone. Every request carries the code as ?t=.

export const PC_PORT = 47800;

export type PcLink = { url: string; token: string; name: string | null };
export type PcItem = {
  id: string;
  kind: 'book' | 'audio';
  title: string;
  author: string | null;
  language: string | null;
  // Pages/chapters of a book, or chapters of an audiobook.
  count: number;
  size: number;
  status: 'ready' | 'downloading' | 'error';
};
export type PcAudio = { title: string; author: string | null; language: string | null; tracks: { title: string; url: string; seconds: number | null }[] };

export class PcLinkError extends Error {}

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function pcQrText(link: PcLink) {
  const name = link.name ? `&n=${encodeURIComponent(link.name)}` : '';
  return `seslikitap://pc?u=${encodeURIComponent(link.url)}&t=${encodeURIComponent(link.token)}${name}`;
}

function normaliseUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const m = s.match(/^(https?):\/\/([^/\s:?#]+)(?::(\d{1,5}))?\/?$/i);
  if (!m) return null;
  return `${m[1].toLowerCase()}://${m[2]}:${m[3] ?? PC_PORT}`;
}

// Reads a scanned QR code / opened link, or what the user typed: the address shown on the computer and its code.
export function parsePcLink(text: string, typedToken?: string): PcLink | null {
  const t = text.trim();
  const q = t.match(/^seslikitap:\/\/+pc\/?\?(.*)$/i);
  if (q) {
    const params: Record<string, string> = {};
    for (const part of q[1].split('&')) {
      const [k, v = ''] = part.split('=');
      try {
        params[k] = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch {
        return null;
      }
    }
    return fromParams(params);
  }
  const url = normaliseUrl(t);
  const token = (typedToken ?? '').trim().toUpperCase();
  return url && token ? { url, token, name: null } : null;
}

// Route params of the seslikitap://pc deep link.
export function fromParams(params: Record<string, string | string[] | undefined>): PcLink | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const url = normaliseUrl(one(params.u));
  const token = one(params.t).trim().toUpperCase();
  return url && token ? { url, token, name: one(params.n).trim() || null } : null;
}

export function pcUrl(link: PcLink, path: string) {
  return `${link.url}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(link.token)}`;
}

async function call<T>(fetchFn: FetchFn, link: PcLink, path: string, init?: { method?: string; body?: string }): Promise<T> {
  let res;
  try {
    res = await fetchFn(pcUrl(link, path), { ...init, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
  } catch {
    throw new PcLinkError(
      'Bilgisayara ulaşılamadı. Telefon ile bilgisayar aynı Wi-Fi ağında mı ve bilgisayardaki Sesli Kitap açık mı? iPhone “Yerel Ağ” izni sorduysa İzin Ver deyip yenileyin.',
    );
  }
  if (res.status === 401 || res.status === 403) throw new PcLinkError('Bağlantı kodu geçersiz. Bilgisayardaki karekodu yeniden okutun.');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new PcLinkError(body?.error ?? `Bilgisayar isteği yanıtlamadı (hata ${res.status}).`);
  }
  return (await res.json()) as T;
}

export function pcInfo(link: PcLink, fetchFn: FetchFn = fetch as unknown as FetchFn) {
  return call<{ app: string; name: string; version: string }>(fetchFn, link, '/api/info');
}

export async function pcLibrary(link: PcLink, fetchFn: FetchFn = fetch as unknown as FetchFn) {
  return (await call<{ items: PcItem[] }>(fetchFn, link, '/api/library')).items;
}

export async function pcAudio(link: PcLink, id: string, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<PcAudio> {
  const a = await call<PcAudio>(fetchFn, link, `/api/library/${encodeURIComponent(id)}/audio`);
  return { ...a, tracks: a.tracks.map((tr) => ({ ...tr, url: pcUrl(link, tr.url) })) };
}

export function pcPackageUrl(link: PcLink, id: string) {
  return pcUrl(link, `/api/library/${encodeURIComponent(id)}/package`);
}

export function pcUpload(link: PcLink, name: string, json: string, fetchFn: FetchFn = fetch as unknown as FetchFn) {
  return call<{ id: string }>(fetchFn, link, `/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: json });
}
