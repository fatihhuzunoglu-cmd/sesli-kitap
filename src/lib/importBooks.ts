import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { insertBook, type BookFormat } from '@/db/database';

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
};

export const NOT_YET_SUPPORTED = ['mobi', 'azw', 'azw3', 'kfx', 'djvu', 'docx', 'doc', 'rtf', 'cbz', 'cbr', 'odt'];

export const SUPPORTED_LABEL = 'PDF, EPUB, TXT, FB2, HTML';

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

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function booksDir() {
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
  if (head[0] === 0x50 && head[1] === 0x4b) return ascii.includes('epub') ? 'epub' : null;
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
    const file = await File.downloadFileAsync(url, tmp);
    const ext = extensionOf(file.name) || extensionOf(url);
    const format = EXTENSIONS[ext] ?? sniffFormat(file);
    if (!format) throw new Error(`Bu dosya türü desteklenmiyor. Desteklenenler: ${SUPPORTED_LABEL}.`);
    const name = extensionOf(file.name) ? file.name : url.split('/').pop() || 'Kitap';
    return await addFile(db, file, name, format, EXTENSIONS[ext] ? ext : format);
  } finally {
    if (tmp.exists) tmp.delete();
  }
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

// Page photos become one book: a folder of numbered images that the engine reads with OCR.
export async function importPhotos(db: SQLiteDatabase, uris: string[], title: string): Promise<string> {
  if (!uris.length) throw new Error('Fotoğraf seçilmedi.');
  const id = newId();
  const dir = new Directory(booksDir(), id);
  dir.create({ intermediates: true, idempotent: true });
  let size = 0;
  for (let i = 0; i < uris.length; i++) {
    const source = new File(uris[i]);
    const ext = extensionOf(source.name) || 'jpg';
    const dest = new File(dir, `${String(i + 1).padStart(4, '0')}.${ext}`);
    await source.copy(dest);
    size += dest.size ?? 0;
  }
  await insertBook(db, { id, title: title.trim() || 'Fotoğraflanan sayfalar', format: 'images', fileUri: dir.uri, size });
  return id;
}

export function deleteBookFile(fileUri: string) {
  const dir = new Directory(fileUri);
  if (dir.exists) {
    dir.delete();
    return;
  }
  const f = new File(fileUri);
  if (f.exists) f.delete();
}
