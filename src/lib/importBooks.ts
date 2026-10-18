import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
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

export type ImportResult = { imported: string[]; rejected: string[] };

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function titleFromName(name: string) {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).replace(/[_]+/g, ' ').trim() || 'Adsız kitap';
}

export async function pickAndImportBooks(db: SQLiteDatabase): Promise<ImportResult> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return { imported: [], rejected: [] };

  const booksDir = new Directory(Paths.document, 'books');
  booksDir.create({ idempotent: true, intermediates: true });

  const imported: string[] = [];
  const rejected: string[] = [];
  for (const asset of result.assets) {
    const ext = extensionOf(asset.name);
    const format = EXTENSIONS[ext];
    if (!format) {
      rejected.push(asset.name);
      continue;
    }
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const source = new File(asset.uri);
    const dest = new File(booksDir, `${id}.${ext}`);
    await source.copy(dest);
    if (source.uri.startsWith(Paths.cache.uri)) source.delete();
    await insertBook(db, { id, title: titleFromName(asset.name), format, fileUri: dest.uri, size: asset.size ?? dest.size ?? 0 });
    imported.push(id);
  }
  return { imported, rejected };
}

export function deleteBookFile(fileUri: string) {
  const f = new File(fileUri);
  if (f.exists) f.delete();
}
