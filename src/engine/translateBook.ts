import type { SQLiteDatabase } from 'expo-sqlite';
import { getBook, getFinishedSectionIdxs, getSection, insertSection, updateBook } from '@/db/database';
import { Translator } from '../../modules/translator';
import { batches, nextIndex } from '@/lib/translation';
import { notifyBooksChanged } from './booksEvents';

// How often to look again while the source book is still being read (OCR) and the next page is not ready.
const WAIT_MS = 1500;
// Titles the app made up itself ("Sayfa 12") stay as they are.
const GENERATED_TITLE = /^(Sayfa|Bölüm) \d+$/;

export type TranslateHooks = {
  // Section the reader is at, so translation starts there.
  focusOf: (bookId: string) => number;
  // Asks the source book's OCR to do this page next.
  focusSource: (bookId: string, idx: number) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Translates a book section by section into a 'translation' book, following its source as OCR makes pages readable.
// Already translated sections are kept, so an interrupted translation continues where it stopped.
export async function translateBook(db: SQLiteDatabase, bookId: string, hooks: TranslateHooks) {
  const native = Translator;
  if (!native) throw new Error('Çeviri bu ortamda kullanılamıyor.');
  if (!native.isSupported()) throw new Error('Çeviri için iOS 18 veya daha yenisi gerekir.');
  const book = await getBook(db, bookId);
  if (!book?.sourceId || !book.translateTo) throw new Error('Çeviri bilgisi eksik.');
  const target = book.translateTo;
  const done = new Set(await getFinishedSectionIdxs(db, bookId));
  const prepared = new Set<string>();
  let sectionCount = book.sectionCount;
  let lastLanguage: string | null = null;

  const languageOf = async (text: string, fallback: string) => {
    if (text.length >= 40) {
      const found = (await native.identifyLanguage(text.slice(0, 1500))).split('-')[0];
      if (found && found !== 'und') {
        lastLanguage = found;
        return found;
      }
    }
    return lastLanguage ?? fallback;
  };

  const translate = async (texts: string[], from: string) => {
    if (!prepared.has(from)) {
      await native.prepare(from, target);
      prepared.add(from);
    }
    const out: string[] = [];
    for (const batch of batches(texts)) out.push(...(await native.translate(batch, from, target)));
    return out;
  };

  for (;;) {
    if (!(await getBook(db, bookId))) return;
    const source = await getBook(db, book.sourceId);
    if (!source) throw new Error('Çevrilen kitap kitaplıktan silinmiş.');
    if (source.status === 'error') throw new Error('Asıl kitap işlenemedi. Önce onu yeniden işleyin.');
    if (source.sectionCount !== sectionCount) {
      sectionCount = source.sectionCount;
      await updateBook(db, bookId, { section_count: sectionCount });
      notifyBooksChanged();
    }
    const idx = nextIndex(sectionCount, done, hooks.focusOf(bookId));
    if (idx === null) {
      if (source.status === 'processing') {
        await sleep(WAIT_MS);
        continue;
      }
      return;
    }
    const section = await getSection(db, source.id, idx);
    if (!section || section.ocrPending) {
      if (source.status !== 'processing') {
        await insertSection(db, bookId, { idx, title: section?.title ?? `Sayfa ${idx + 1}`, text: '', ocr: 2 });
        done.add(idx);
        continue;
      }
      hooks.focusSource(source.id, idx);
      await sleep(WAIT_MS);
      continue;
    }

    const paragraphs = section.text.split('\n').filter((p) => p.trim());
    let title = section.title;
    let text = section.text;
    if (paragraphs.length) {
      const from = await languageOf(section.text, source.language);
      if (from !== target) {
        const keepTitle = GENERATED_TITLE.test(title);
        const out = await translate(keepTitle ? paragraphs : [title, ...paragraphs], from);
        if (!keepTitle) title = out.shift() || title;
        text = out.join('\n');
      }
    }
    await insertSection(db, bookId, { idx, title, text, ocr: section.needsOcr && !text ? 2 : 0 });
    done.add(idx);
    notifyBooksChanged();
  }
}
