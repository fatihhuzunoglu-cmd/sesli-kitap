import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { findTranslation, getSectionsRange, insertBook, insertSections, listBookIds, updateBook, type Book, type BookFormat } from '@/db/database';
import { buildPackage, PACKAGE_EXTENSION, packageFileName, parsePackage } from './bookPackage';
import { languageLabel } from './voices';

const EXTENSIONS: Record<string, BookFormat> = {
  pdf: 'pdf',
  epub: 'epub',
  txt: 'txt',
  text: 'txt',
  md: 'txt',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  fb2: 'fb2',
  docx: 'docx',
  mobi: 'mobi',
  azw3: 'mobi',
  azw: 'mobi',
  prc: 'mobi',
};

export const NOT_YET_SUPPORTED = ['kfx', 'djvu', 'doc', 'rtf', 'cbz', 'cbr', 'odt', 'pages'];

export const SUPPORTED_LABEL = 'PDF, EPUB, MOBI, AZW3, DOCX, FB2, TXT, HTML, SKITAP';

export type ImportResult = { imported: string[]; rejected: string[] };

function extensionOf(name: string) {
  const clean = name.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

function titleFromName(name: string) {
  let base = name.split(/[?#]/)[0];
  try {
    base = decodeURIComponent(base);
  } catch {}
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).replace(/[_]+/g, ' ').trim() || 'Adsız kitap';
}

export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function booksDir() {
  const dir = new Directory(Paths.document, 'books');
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}

// Identifies files whose name has no usable extension (common with download links).
function sniffFormat(file: File): BookFormat | null {
  const handle = file.open(FileMode.ReadOnly);
  let head: Uint8Array;
  try {
    head = handle.readBytesSync(512);
  } finally {
    handle.close();
  }
  const ascii = String.fromCharCode(...head.slice(0, 512));
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (ascii.slice(60, 68) === 'BOOKMOBI') return 'mobi';
  if (head[0] === 0x50 && head[1] === 0x4b) return ascii.includes('epub') ? 'epub' : ascii.includes('word/') ? 'docx' : null;
  if (/<FictionBook/i.test(ascii)) return 'fb2';
  if (/<html|<!doctype html/i.test(ascii)) return 'html';
  if (!head.slice(0, 512).some((b) => b === 0)) return 'txt';
  return null;
}

async function addFile(db: SQLiteDatabase, source: File, displayName: string, format: BookFormat, ext: string) {
  const id = newId();
  const dest = new File(booksDir(), `${id}.${ext}`);
  await source.copy(dest);
  await insertBook(db, { id, title: titleFromName(displayName), format, fileUri: dest.uri, size: dest.size ?? 0 });
  return id;
}

export async function pickAndImportBooks(db: SQLiteDatabase): Promise<ImportResult> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return { imported: [], rejected: [] };

  const imported: string[] = [];
  const rejected: string[] = [];
  for (const asset of result.assets) {
    const source = new File(asset.uri);
    try {
      const ext = extensionOf(asset.name);
      if (ext === PACKAGE_EXTENSION || (ext === 'json' && isPackage(source))) {
        imported.push(await importPackage(db, await source.text()));
        continue;
      }
      const format = EXTENSIONS[ext] ?? (NOT_YET_SUPPORTED.includes(ext) ? null : sniffFormat(source));
      if (!format) {
        rejected.push(asset.name);
        continue;
      }
      imported.push(await addFile(db, source, asset.name, format, EXTENSIONS[ext] ? ext : format));
    } finally {
      if (source.uri.startsWith(Paths.cache.uri) && source.exists) source.delete();
    }
  }
  return { imported, rejected };
}

export async function importFromUrl(db: SQLiteDatabase, rawUrl: string): Promise<string> {
  const url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Bağlantı http:// veya https:// ile başlamalı.');
  const tmp = new Directory(Paths.cache, `download-${newId()}`);
  tmp.create({ intermediates: true, idempotent: true });
  try {
    let file: File;
    try {
      file = await File.downloadFileAsync(url, tmp);
    } catch (e) {
      const status = String((e as Error).message ?? '').match(/\b([45]\d\d)\b/)?.[1];
      throw new Error(
        status === '404'
          ? 'Bu bağlantıda dosya bulunamadı (404). Bağlantıyı kontrol edin.'
          : status
            ? `Sunucu dosyayı vermedi (hata ${status}).`
            : 'Dosya indirilemedi. İnternet bağlantınızı ve bağlantının doğru olduğunu kontrol edin.',
      );
    }
    const ext = extensionOf(file.name) || extensionOf(url);
    const format = EXTENSIONS[ext] ?? sniffFormat(file);
    if (!format) throw new Error(`Bu dosya türü desteklenmiyor. Desteklenenler: ${SUPPORTED_LABEL}.`);
    const name = extensionOf(file.name) ? file.name : url.split('/').pop() || 'Kitap';
    return await addFile(db, file, name, format, EXTENSIONS[ext] ? ext : format);
  } finally {
    if (tmp.exists) tmp.delete();
  }
}

function isPackage(file: File) {
  const handle = file.open(FileMode.ReadOnly);
  try {
    return /"type"\s*:\s*"seslikitap"/.test(String.fromCharCode(...handle.readBytesSync(200)));
  } finally {
    handle.close();
  }
}

// A ready-made book from the computer app or another phone: its text is already there, so it opens at once.
export async function importPackage(db: SQLiteDatabase, json: string): Promise<string> {
  const pkg = parsePackage(json);
  const id = newId();
  await insertBook(db, { id, title: pkg.title, author: pkg.author, language: pkg.language, format: 'skitap', fileUri: '', size: json.length, originFormat: pkg.origin });
  await insertSections(
    db,
    id,
    pkg.sections.map((sec, idx) => ({ idx, title: sec.title, text: sec.text, ocr: sec.text.trim() ? 0 : 2 })),
  );
  await updateBook(db, id, { section_count: pkg.sections.length, status: 'ready' });
  return id;
}

// Downloads a package (from the computer app) and adds it.
export async function importPackageFromUrl(db: SQLiteDatabase, url: string): Promise<string> {
  const tmp = new Directory(Paths.cache, `package-${newId()}`);
  tmp.create({ intermediates: true, idempotent: true });
  try {
    const file = await File.downloadFileAsync(url, new File(tmp, `book.${PACKAGE_EXTENSION}`));
    return await importPackage(db, await file.text());
  } finally {
    if (tmp.exists) tmp.delete();
  }
}

// The book's text as a package (JSON), for the computer app or for sharing with another phone.
export async function exportPackage(db: SQLiteDatabase, book: Book): Promise<{ name: string; json: string }> {
  const rows = await getSectionsRange(db, book.id, 0, Math.max(0, book.sectionCount - 1));
  if (!rows.length) throw new Error('Bu kitabın henüz hazır sayfası yok.');
  const origin = book.format === 'translation' ? (book.sourceFormat ?? 'txt') : book.format === 'skitap' ? (book.originFormat ?? 'txt') : book.format;
  const pkg = buildPackage({
    title: book.title,
    author: book.author,
    language: book.language,
    origin,
    sections: rows.map((r) => ({ title: r.title, text: r.text })),
  });
  return { name: packageFileName(book.title), json: JSON.stringify(pkg) };
}

export async function writePackageFile(db: SQLiteDatabase, book: Book): Promise<File> {
  const { name, json } = await exportPackage(db, book);
  const dir = new Directory(Paths.cache, 'export');
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  await file.write(json);
  return file;
}

export async function importText(db: SQLiteDatabase, title: string, text: string): Promise<string> {
  const tmp = new File(Paths.cache, `${newId()}.txt`);
  await tmp.write(text);
  try {
    return await addFile(db, tmp, `${title.trim() || 'Yapıştırılan metin'}.txt`, 'txt', 'txt');
  } finally {
    if (tmp.exists) tmp.delete();
  }
}

// Copies page photos into a photo book's folder, numbered after the pages already there. Returns the bytes added.
async function copyPhotos(dir: Directory, uris: string[]) {
  const existing = dir.list().filter((e): e is File => e instanceof File);
  let next = existing.reduce((n, f) => Math.max(n, parseInt(f.name, 10) || 0), 0);
  let size = 0;
  for (const uri of uris) {
    const source = new File(uri);
    const ext = extensionOf(source.name) || 'jpg';
    const dest = new File(dir, `${String(++next).padStart(4, '0')}.${ext}`);
    await source.copy(dest);
    size += dest.size ?? 0;
  }
  return size;
}

// Page photos become one book: a folder of numbered images that the engine reads with OCR.
export async function importPhotos(db: SQLiteDatabase, uris: string[], title: string): Promise<string> {
  if (!uris.length) throw new Error('Fotoğraf seçilmedi.');
  const id = newId();
  const dir = new Directory(booksDir(), id);
  dir.create({ intermediates: true, idempotent: true });
  const size = await copyPhotos(dir, uris);
  await insertBook(db, { id, title: title.trim() || 'Fotoğraflanan sayfalar', format: 'images', fileUri: dir.uri, size });
  return id;
}

// Adds more page photos to the end of a photo book. Returns the books to (re)process: the book and its translations,
// which then only recognise and translate the new pages.
export async function addPhotosToBook(db: SQLiteDatabase, book: Book, uris: string[]): Promise<string[]> {
  if (!uris.length) return [];
  const dir = new Directory(book.fileUri);
  const added = await copyPhotos(dir, uris);
  await updateBook(db, book.id, { size: book.size + added, status: 'processing', error: null });
  const translations = await listBookIds(db, { sourceId: book.id });
  for (const id of translations) await updateBook(db, id, { status: 'processing', error: null });
  return [book.id, ...translations];
}

// Creates (or finds) the translation of a book into `language`. Its pages are filled in by the translation queue.
export async function createTranslation(db: SQLiteDatabase, source: Book, language: string): Promise<string> {
  const existing = await findTranslation(db, source.id, language);
  if (existing) return existing;
  const id = newId();
  await insertBook(db, {
    id,
    title: `${source.title} (${languageLabel(language)})`,
    author: source.author,
    format: 'translation',
    fileUri: '',
    size: 0,
    language,
    sourceId: source.id,
    translateTo: language,
  });
  await updateBook(db, id, { section_count: source.sectionCount });
  return id;
}

export function deleteBookFile(fileUri: string) {
  if (!fileUri) return;
  const dir = new Directory(fileUri);
  if (dir.exists) {
    dir.delete();
    return;
  }
  const f = new File(fileUri);
  if (f.exists) f.delete();
}
