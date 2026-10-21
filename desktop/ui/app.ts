// The computer app's window: library, converting books for the phone, finding books online, pairing with phones.
import { buildPackage, PACKAGE_EXTENSION } from '../../src/lib/bookPackage';
import { SOURCE_LABEL, type CatalogItem, type CatalogKind } from '../../src/lib/catalog';
import type { PcItem } from '../../src/lib/pcLink';
import { guessLanguage } from '../../src/lib/text';
import { Engine, type Converted } from './engine';

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Hata ${res.status}`);
  return body;
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const FORMATS: Record<string, string> = {
  pdf: 'pdf', epub: 'epub', txt: 'txt', text: 'txt', md: 'txt', html: 'html', htm: 'html', xhtml: 'html', fb2: 'fb2', docx: 'docx',
  mobi: 'mobi', azw3: 'mobi', azw: 'mobi', prc: 'mobi',
};
const IMAGES = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'];
const extOf = (name: string) => name.split('.').pop()!.toLowerCase();
const baseName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Adsız kitap';

const languageNames = new Intl.DisplayNames(['tr'], { type: 'language' });
function languageName(code: string) {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const engine = new Engine();
const main = document.getElementById('main')!;
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
let current = 'library';
let pollTimer: ReturnType<typeof setInterval> | null = null;

function show(tab: string) {
  current = tab;
  tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  main.replaceChildren();
  if (tab === 'library') void renderLibrary();
  else if (tab === 'convert') renderConvert();
  else if (tab === 'search') renderSearch();
  else if (tab === 'pair') void renderPair();
}
tabs.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));

// ---------- Library ----------
async function renderLibrary() {
  const box = h('section', { class: 'panel' });
  main.replaceChildren(box);
  const draw = async () => {
    let items: PcItem[];
    try {
      items = (await api<{ items: PcItem[] }>('/api/library')).items;
    } catch (e) {
      box.replaceChildren(h('p', { class: 'error' }, (e as Error).message));
      return;
    }
    if (current !== 'library') return;
    if (!items.length) {
      box.replaceChildren(
        h('div', { class: 'empty' },
          h('h2', {}, 'Kitaplık boş'),
          h('p', {}, 'Taranmış PDF’leri, e-kitapları ya da sayfa fotoğraflarını telefonda hemen açılan kitaplara dönüştürün; internetten sesli kitap indirin. Telefon, karekodla bağlanınca bunları alır.'),
          h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: () => show('convert') }, 'Kitap dönüştür'),
            h('button', { onclick: () => show('search') }, 'İnternetten bul'),
          ),
        ),
      );
      return;
    }
    box.replaceChildren(
      h('p', { class: 'muted' }, 'Telefon bağlıyken bu kitapları “Bilgisayardan al” ekranında görür. Dosyayı kaydedip WhatsApp, e-posta ya da USB ile de gönderebilirsiniz.'),
      h('ul', { class: 'list' }, ...items.map(itemRow)),
    );
  };
  await draw();
  pollTimer = setInterval(() => void draw(), 2500);
}

function itemRow(it: PcItem) {
  const status = it.status === 'downloading' ? 'İndiriliyor…' : it.status === 'error' ? 'Bazı bölümler indirilemedi' : '';
  return h('li', { class: 'item' },
    h('span', { class: `badge ${it.kind}` }, it.kind === 'audio' ? 'SESLİ KİTAP' : 'KİTAP'),
    h('div', { class: 'grow' },
      h('strong', {}, it.title),
      h('div', { class: 'muted' }, [it.author, it.kind === 'audio' ? `${it.count} bölüm` : `${it.count} sayfa/bölüm`, formatSize(it.size), status].filter(Boolean).join(' · ')),
    ),
    it.kind === 'book' ? h('a', { class: 'button', href: `/api/library/${it.id}/package?download=1`, download: '' }, 'Dosyayı kaydet') : null,
    it.status === 'error' ? h('button', { onclick: () => void api(`/api/library/${it.id}/retry`, { method: 'POST' }).then(() => show('library')) }, 'Yeniden dene') : null,
    h('button', {
      class: 'danger',
      onclick: async () => {
        if (!confirm(`“${it.title}” bilgisayardan silinsin mi?`)) return;
        await api(`/api/library/${it.id}`, { method: 'DELETE' });
        show('library');
      },
    }, 'Sil'),
  );
}

// ---------- Converting ----------
type Job = { name: string; kind: string; files: File[] | Uint8Array[]; title?: string; row: HTMLElement };
const jobs: Job[] = [];
let converting = false;
const jobList = h('ul', { class: 'list' });

function renderConvert() {
  const input = h('input', { type: 'file', multiple: true, hidden: true, accept: [...Object.keys(FORMATS), ...IMAGES, PACKAGE_EXTENSION].map((e) => `.${e}`).join(','), 'data-testid': 'file-input' });
  input.addEventListener('change', () => {
    if (input.files?.length) addFiles([...input.files]);
    input.value = '';
  });
  const drop = h('div', { class: 'drop', tabindex: 0, onclick: () => input.click() },
    h('strong', {}, 'Dosyaları buraya sürükleyin ya da tıklayıp seçin'),
    h('span', { class: 'muted' }, 'PDF (taranmış olanlar dahil), EPUB, MOBI/AZW3, DOCX, FB2, TXT, HTML · sayfa fotoğrafları (JPG, PNG) tek kitap olur'),
  );
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles([...(e.dataTransfer?.files ?? [])]);
  });
  main.replaceChildren(
    h('section', { class: 'panel' },
      h('p', { class: 'muted' }, 'Bilgisayar kitabı okur, taranmış sayfaları metne çevirir (OCR) ve telefonun hemen açabileceği hazır bir kitap (.skitap) yapar. Telefon bu kitabı beklemeden okumaya başlar.'),
      drop,
      input,
      jobList,
    ),
  );
}

function addFiles(files: File[]) {
  const images = files.filter((f) => IMAGES.includes(extOf(f.name))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const others = files.filter((f) => !IMAGES.includes(extOf(f.name)));
  for (const f of others) {
    const ext = extOf(f.name);
    if (ext === PACKAGE_EXTENSION) {
      void f.text().then((json) => api('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: json })).then(
        () => jobList.prepend(h('li', { class: 'item' }, h('div', { class: 'grow' }, h('strong', {}, f.name), h('div', { class: 'ok' }, 'Kitaplığa eklendi')))),
        (e) => alert((e as Error).message),
      );
      continue;
    }
    const kind = FORMATS[ext];
    if (!kind) {
      alert(`${f.name}: bu dosya türü desteklenmiyor.`);
      continue;
    }
    enqueue({ name: f.name, kind, files: [f], row: h('li') });
  }
  if (images.length) {
    const title = prompt(`${images.length} sayfa fotoğrafı tek kitap olacak. Kitabın adı:`, `Fotoğraflanan sayfalar ${new Date().toLocaleDateString('tr-TR')}`);
    if (title !== null) enqueue({ name: `${images.length} sayfa fotoğrafı`, kind: 'images', files: images, title: title.trim() || 'Fotoğraflanan sayfalar', row: h('li') });
  }
}

function enqueue(job: Job) {
  job.row.className = 'item job';
  job.row.replaceChildren(h('div', { class: 'grow' }, h('strong', {}, job.title ?? job.name), h('div', { class: 'muted' }, 'Sırada')));
  jobList.append(job.row);
  jobs.push(job);
  void pump();
}

async function pump() {
  if (converting) return;
  converting = true;
  try {
    while (jobs.length) await runJob(jobs.shift()!);
  } finally {
    converting = false;
  }
}

async function runJob(job: Job) {
  const status = h('div', { class: 'muted' }, 'Hazırlanıyor…');
  const bar = h('progress', { max: 1 });
  const stop = h('button', { onclick: () => engine.cancel() }, 'Durdur');
  job.row.replaceChildren(h('div', { class: 'grow' }, h('strong', {}, job.title ?? job.name), status, bar), stop);
  const started = Date.now();
  try {
    const files = await Promise.all(job.files.map(async (f) => (f instanceof Uint8Array ? f : new Uint8Array(await f.arrayBuffer()))));
    const result: Converted = await engine.convert(job.kind, files, (p) => {
      status.textContent = p.text;
      if (p.fraction === null) bar.removeAttribute('value');
      else bar.value = p.fraction;
    });
    const sample = result.sections.map((s) => s.text).filter(Boolean).join('\n').slice(0, 8000);
    const pkg = buildPackage({
      title: job.title ?? (result.title?.trim() || baseName(job.name)),
      author: result.author?.trim() || null,
      language: guessLanguage(sample, result.language),
      origin: job.kind,
      sections: result.sections.map((s) => ({ title: s.title, text: s.text })),
    });
    await api('/api/upload?name=' + encodeURIComponent(pkg.title), { method: 'POST', body: JSON.stringify(pkg) });
    const empty = result.sections.filter((s) => s.empty).length;
    const seconds = Math.round((Date.now() - started) / 1000);
    const preview = result.sections.find((s) => s.text.trim().length > 80)?.text.slice(0, 400) ?? '';
    job.row.replaceChildren(
      h('div', { class: 'grow' },
        h('strong', {}, pkg.title),
        h('div', { class: 'ok', 'data-testid': 'convert-done' }, `Hazır · ${pkg.sections.length} sayfa/bölüm${empty ? ` (${empty} tanesinde metin yok)` : ''} · ${seconds} sn · kitaplığa eklendi`),
        preview ? h('blockquote', {}, preview + '…') : null,
      ),
    );
  } catch (e) {
    job.row.replaceChildren(h('div', { class: 'grow' }, h('strong', {}, job.title ?? job.name), h('div', { class: 'error' }, (e as Error).message)));
  }
}

// ---------- Finding books online ----------
let searchKind: CatalogKind = 'audio';
let turkishOnly = false;

function renderSearch() {
  const input = h('input', { type: 'search', placeholder: 'Kitap ya da yazar adı', 'aria-label': 'Ara' });
  const results = h('ul', { class: 'list' });
  const go = async () => {
    if (input.value.trim().length < 2) return;
    results.replaceChildren(h('li', { class: 'muted' }, 'Aranıyor…'));
    try {
      const { items } = await api<{ items: CatalogItem[] }>(`/api/search?q=${encodeURIComponent(input.value)}&kind=${searchKind}&tr=${turkishOnly ? 1 : 0}`);
      results.replaceChildren(...(items.length ? items.map(resultRow) : [h('li', { class: 'muted' }, 'Sonuç bulunamadı. Başka bir kelime deneyin.')]));
    } catch (e) {
      results.replaceChildren(h('li', { class: 'error' }, (e as Error).message));
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
  const pill = (label: string, active: () => boolean, onclick: () => void) => {
    const b = h('button', { class: 'pill', 'aria-pressed': String(active()) }, label);
    b.addEventListener('click', () => {
      onclick();
      renderSearchKeep();
    });
    return b;
  };
  const renderSearchKeep = () => {
    const q = input.value;
    renderSearch();
    const fresh = main.querySelector<HTMLInputElement>('input[type=search]')!;
    fresh.value = q;
    if (q.trim().length >= 2) fresh.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  };
  main.replaceChildren(
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, input, h('button', { class: 'primary', onclick: () => void go() }, 'Ara')),
      h('div', { class: 'row' },
        pill('Sesli kitap', () => searchKind === 'audio', () => (searchKind = 'audio')),
        pill('E-kitap', () => searchKind === 'ebook', () => (searchKind = 'ebook')),
        pill('Yalnız Türkçe', () => turkishOnly, () => (turkishOnly = !turkishOnly)),
      ),
      h('p', { class: 'muted' },
        searchKind === 'audio'
          ? 'LibriVox’un kamu malı sesli kitapları ve Internet Archive’da açık lisansla paylaşılmış sesli kitaplar. Lisans yükleyenin beyanıdır; telifli olduğunu bildiğiniz eserleri indirmeyin.'
          : 'Project Gutenberg’in telifsiz e-kitapları. Dönüştürülüp telefonda uygulamanın sesiyle okunur.',
      ),
      results,
    ),
  );
  input.focus();
}

function resultRow(it: CatalogItem) {
  const button = h('button', { class: 'primary' }, it.kind === 'audio' ? 'Bilgisayara indir' : 'Dönüştür ve ekle');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (it.kind === 'audio') {
        button.textContent = 'Bölümler alınıyor…';
        await api('/api/download', { method: 'POST', body: JSON.stringify(it) });
        button.textContent = 'İndiriliyor — Kitaplık’ta';
      } else {
        button.textContent = 'İndiriliyor…';
        const res = await fetch(`/api/fetch?url=${encodeURIComponent(it.url!)}`);
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'İndirilemedi.');
        const bytes = new Uint8Array(await res.arrayBuffer());
        button.textContent = 'Dönüştürme sırasında';
        enqueue({ name: `${it.title}.${it.format}`, kind: it.format === 'txt' ? 'txt' : 'epub', files: [bytes], title: it.title, row: h('li') });
        show('convert');
      }
    } catch (e) {
      button.disabled = false;
      button.textContent = 'Yeniden dene';
      alert((e as Error).message);
    }
  });
  return h('li', { class: 'item' },
    h('div', { class: 'grow' },
      h('div', { class: 'source' }, `${SOURCE_LABEL[it.source]}${it.language ? ` · ${languageName(it.language)}` : ''}`),
      h('strong', {}, it.title),
      h('div', { class: 'muted' }, [it.author, it.detail].filter(Boolean).join(' · ')),
    ),
    button,
  );
}

// ---------- Pairing a phone ----------
async function renderPair(address?: string) {
  type Pair = { token: string; port: number; address: string; addresses: { name: string; address: string }[]; link: string; name: string; qr: string };
  let p: Pair;
  try {
    p = await api<Pair>(`/api/pair${address ? `?address=${encodeURIComponent(address)}` : ''}`);
  } catch (e) {
    main.replaceChildren(h('p', { class: 'error' }, (e as Error).message));
    return;
  }
  const qr = h('div', { class: 'qr', 'aria-label': 'Bağlantı karekodu' });
  qr.innerHTML = p.qr;
  const select = p.addresses.length > 1
    ? h('select', { onchange: (e: Event) => void renderPair((e.target as HTMLSelectElement).value) },
        ...p.addresses.map((a) => h('option', { value: a.address, selected: a.address === p.address }, `${a.address} (${a.name})`)))
    : null;
  main.replaceChildren(
    h('section', { class: 'panel pair' },
      qr,
      h('div', { class: 'grow' },
        h('h2', {}, 'Telefonu bağla'),
        h('ol', {},
          h('li', {}, 'Telefon ile bu bilgisayar aynı Wi-Fi ağında olsun.'),
          h('li', {}, 'Telefonda Sesli Kitap → + → “Bilgisayardan al” → “Karekodu tara”. (Telefonun kamera uygulamasıyla okutmak da olur.)'),
          h('li', {}, 'Bağlanınca telefon bu bilgisayardaki kitapları görür, alır; kendi kitaplarını da buraya gönderebilir.'),
        ),
        h('p', { class: 'muted' }, 'Elle bağlanmak için telefona şunları yazın:'),
        h('div', { class: 'code' }, h('span', {}, 'Adres'), h('strong', {}, `${p.address}:${p.port}`)),
        h('div', { class: 'code' }, h('span', {}, 'Bağlantı kodu'), h('strong', { 'data-testid': 'pair-code' }, p.token)),
        select ? h('p', { class: 'muted' }, 'Telefon bağlanamazsa başka bir ağ adresi seçin: ', select) : null,
        h('p', { class: 'muted' }, 'Windows güvenlik duvarı izin sorarsa “Özel ağlar” için “İzin ver”i seçin; yoksa telefon bilgisayara ulaşamaz.'),
      ),
    ),
  );
}

show('library');
