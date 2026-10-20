import type { SQLiteDatabase } from 'expo-sqlite';

// 'translation' books have no file: their sections are translated from another book (source_id).
export type BookFormat = 'pdf' | 'epub' | 'txt' | 'html' | 'fb2' | 'images' | 'docx' | 'mobi' | 'translation';
export type BookStatus = 'processing' | 'ready' | 'error';

export type Book = {
  id: string;
  title: string;
  author: string | null;
  format: BookFormat;
  fileUri: string;
  size: number;
  language: string;
  sectionCount: number;
  processedCount: number;
  ocrPendingCount: number;
  status: BookStatus;
  error: string | null;
  addedAt: number;
  lastOpenedAt: number | null;
  progress: number;
  sourceId: string | null;
  // Format of the book a translation was made from, which decides whether its sections are pages or chapters.
  sourceFormat: BookFormat | null;
  translateTo: string | null;
};

// needs_ocr: 0 = text is final, 1 = image page waiting for OCR, 2 = OCR found no text on it.
export type OcrState = 0 | 1 | 2;
export type Section = { idx: number; title: string; text: string; needsOcr: boolean; ocrPending: boolean };
export type SectionInput = { idx: number; title: string; text: string; ocr: OcrState };
export type Position = { sectionIdx: number; sentenceIdx: number };

const MIGRATIONS: string[] = [
  `CREATE TABLE books (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT NOT NULL,
    file_uri TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    language TEXT NOT NULL DEFAULT 'tr',
    section_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT,
    added_at INTEGER NOT NULL,
    last_opened_at INTEGER
  );
  CREATE TABLE sections (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    needs_ocr INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, idx)
  );
  CREATE TABLE positions (
    book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    section_idx INTEGER NOT NULL,
    sentence_idx INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`,
  `CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    section_idx INTEGER NOT NULL,
    sentence_idx INTEGER NOT NULL,
    excerpt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX bookmarks_book ON bookmarks(book_id, section_idx, sentence_idx);`,
  `ALTER TABLE books ADD COLUMN source_id TEXT;
  ALTER TABLE books ADD COLUMN translate_to TEXT;`,
];

export async function migrate(db: SQLiteDatabase) {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(MIGRATIONS[version]);
    });
    version++;
    await db.execAsync(`PRAGMA user_version = ${version}`);
  }
}

type BookRow = {
  id: string;
  title: string;
  author: string | null;
  format: BookFormat;
  file_uri: string;
  size: number;
  language: string;
  section_count: number;
  processed_count: number;
  ocr_pending_count: number;
  status: BookStatus;
  error: string | null;
  added_at: number;
  last_opened_at: number | null;
  section_idx: number | null;
  source_id: string | null;
  source_format: BookFormat | null;
  translate_to: string | null;
};

const BOOK_SELECT = `
  SELECT b.*,
    (SELECT COUNT(*) FROM sections s WHERE s.book_id = b.id) AS processed_count,
    (SELECT COUNT(*) FROM sections s WHERE s.book_id = b.id AND s.needs_ocr > 0) AS ocr_pending_count,
    (SELECT src.format FROM books src WHERE src.id = b.source_id) AS source_format,
    p.section_idx
  FROM books b LEFT JOIN positions p ON p.book_id = b.id`;

function toBook(r: BookRow): Book {
  const progress = r.section_count > 0 && r.section_idx != null ? (r.section_idx + 1) / r.section_count : 0;
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    format: r.format,
    fileUri: r.file_uri,
    size: r.size,
    language: r.language,
    sectionCount: r.section_count,
    processedCount: r.processed_count,
    ocrPendingCount: r.ocr_pending_count,
    status: r.status,
    error: r.error,
    addedAt: r.added_at,
    lastOpenedAt: r.last_opened_at,
    progress,
    sourceId: r.source_id,
    sourceFormat: r.source_format,
    translateTo: r.translate_to,
  };
}

export async function listBooks(db: SQLiteDatabase): Promise<Book[]> {
  const rows = await db.getAllAsync<BookRow>(`${BOOK_SELECT} ORDER BY COALESCE(b.last_opened_at, b.added_at) DESC`);
  return rows.map(toBook);
}

export async function getBook(db: SQLiteDatabase, id: string): Promise<Book | null> {
  const row = await db.getFirstAsync<BookRow>(`${BOOK_SELECT} WHERE b.id = ?`, id);
  return row ? toBook(row) : null;
}

export async function insertBook(
  db: SQLiteDatabase,
  b: Pick<Book, 'id' | 'title' | 'format' | 'fileUri' | 'size'> & Partial<Pick<Book, 'author' | 'language' | 'sourceId' | 'translateTo'>>,
) {
  await db.runAsync(
    `INSERT INTO books (id, title, author, format, file_uri, size, language, source_id, translate_to, status, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
    b.id,
    b.title,
    b.author ?? null,
    b.format,
    b.fileUri,
    b.size,
    b.language ?? 'tr',
    b.sourceId ?? null,
    b.translateTo ?? null,
    Date.now(),
  );
}

export async function listBookIds(db: SQLiteDatabase, where: { status?: BookStatus; sourceId?: string }) {
  const rows = await db.getAllAsync<{ id: string }>(
    'SELECT id FROM books WHERE (? IS NULL OR status = ?) AND (? IS NULL OR source_id = ?) ORDER BY added_at',
    where.status ?? null,
    where.status ?? null,
    where.sourceId ?? null,
    where.sourceId ?? null,
  );
  return rows.map((r) => r.id);
}

export async function findTranslation(db: SQLiteDatabase, sourceId: string, language: string) {
  const r = await db.getFirstAsync<{ id: string }>('SELECT id FROM books WHERE source_id = ? AND translate_to = ?', sourceId, language);
  return r?.id ?? null;
}

export async function updateBook(
  db: SQLiteDatabase,
  id: string,
  fields: Partial<{
    title: string;
    author: string | null;
    language: string;
    section_count: number;
    size: number;
    status: BookStatus;
    error: string | null;
    last_opened_at: number;
  }>,
) {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  await db.runAsync(
    `UPDATE books SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => fields[k] ?? null),
    id,
  );
}

export async function deleteBook(db: SQLiteDatabase, id: string) {
  await db.runAsync('DELETE FROM books WHERE id = ?', id);
}

export async function insertSection(db: SQLiteDatabase, bookId: string, s: SectionInput) {
  await db.runAsync(
    'INSERT OR REPLACE INTO sections (book_id, idx, title, text, needs_ocr) VALUES (?, ?, ?, ?, ?)',
    bookId,
    s.idx,
    s.title,
    s.text,
    s.ocr,
  );
}

// Sections whose text will not change any more, so a resumed job can skip them.
export async function getFinishedSectionIdxs(db: SQLiteDatabase, bookId: string) {
  const rows = await db.getAllAsync<{ idx: number }>('SELECT idx FROM sections WHERE book_id = ? AND needs_ocr != 1', bookId);
  return rows.map((r) => r.idx);
}

export async function getSection(db: SQLiteDatabase, bookId: string, idx: number): Promise<Section | null> {
  const r = await db.getFirstAsync<{ idx: number; title: string; text: string; needs_ocr: number }>(
    'SELECT idx, title, text, needs_ocr FROM sections WHERE book_id = ? AND idx = ?',
    bookId,
    idx,
  );
  return r ? { idx: r.idx, title: r.title, text: r.text, needsOcr: r.needs_ocr > 0, ocrPending: r.needs_ocr === 1 } : null;
}

export async function getSectionTitles(db: SQLiteDatabase, bookId: string) {
  return db.getAllAsync<{ idx: number; title: string; needs_ocr: number }>(
    'SELECT idx, title, needs_ocr FROM sections WHERE book_id = ? ORDER BY idx',
    bookId,
  );
}

export async function getSampleText(db: SQLiteDatabase, bookId: string): Promise<string> {
  const rows = await db.getAllAsync<{ text: string }>(
    `SELECT text FROM sections WHERE book_id = ? AND length(text) > 200 ORDER BY idx LIMIT 5`,
    bookId,
  );
  return rows.map((r) => r.text).join('\n').slice(0, 8000);
}

export async function getPosition(db: SQLiteDatabase, bookId: string): Promise<Position | null> {
  const r = await db.getFirstAsync<{ section_idx: number; sentence_idx: number }>(
    'SELECT section_idx, sentence_idx FROM positions WHERE book_id = ?',
    bookId,
  );
  return r ? { sectionIdx: r.section_idx, sentenceIdx: r.sentence_idx } : null;
}

export async function savePosition(db: SQLiteDatabase, bookId: string, pos: Position) {
  await db.runAsync(
    `INSERT INTO positions (book_id, section_idx, sentence_idx, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET section_idx = excluded.section_idx, sentence_idx = excluded.sentence_idx, updated_at = excluded.updated_at`,
    bookId,
    pos.sectionIdx,
    pos.sentenceIdx,
    Date.now(),
  );
}

export async function getSetting<T>(db: SQLiteDatabase, key: string, fallback: T): Promise<T> {
  const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return r ? (JSON.parse(r.value) as T) : fallback;
}

export async function setSetting(db: SQLiteDatabase, key: string, value: unknown) {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export type Bookmark = { id: number; sectionIdx: number; sentenceIdx: number; excerpt: string; sectionTitle: string; createdAt: number };

export async function listBookmarks(db: SQLiteDatabase, bookId: string): Promise<Bookmark[]> {
  const rows = await db.getAllAsync<{ id: number; section_idx: number; sentence_idx: number; excerpt: string; title: string | null; created_at: number }>(
    `SELECT m.id, m.section_idx, m.sentence_idx, m.excerpt, s.title, m.created_at
     FROM bookmarks m LEFT JOIN sections s ON s.book_id = m.book_id AND s.idx = m.section_idx
     WHERE m.book_id = ? ORDER BY m.section_idx, m.sentence_idx`,
    bookId,
  );
  return rows.map((r) => ({
    id: r.id,
    sectionIdx: r.section_idx,
    sentenceIdx: r.sentence_idx,
    excerpt: r.excerpt,
    sectionTitle: r.title ?? '',
    createdAt: r.created_at,
  }));
}

export async function addBookmark(db: SQLiteDatabase, bookId: string, pos: Position, excerpt: string) {
  await db.runAsync(
    'INSERT INTO bookmarks (book_id, section_idx, sentence_idx, excerpt, created_at) VALUES (?, ?, ?, ?, ?)',
    bookId,
    pos.sectionIdx,
    pos.sentenceIdx,
    excerpt.slice(0, 280),
    Date.now(),
  );
}

export async function deleteBookmark(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM bookmarks WHERE id = ?', id);
}

export async function findBookmark(db: SQLiteDatabase, bookId: string, pos: Position) {
  return db.getFirstAsync<{ id: number }>(
    'SELECT id FROM bookmarks WHERE book_id = ? AND section_idx = ? AND sentence_idx = ?',
    bookId,
    pos.sectionIdx,
    pos.sentenceIdx,
  );
}

export async function getSectionsRange(db: SQLiteDatabase, bookId: string, from: number, to: number) {
  return db.getAllAsync<{ idx: number; title: string; text: string }>(
    'SELECT idx, title, text FROM sections WHERE book_id = ? AND idx BETWEEN ? AND ? ORDER BY idx',
    bookId,
    from,
    to,
  );
}
