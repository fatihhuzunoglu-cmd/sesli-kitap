import type { Book } from '@/db/database';

// Whether a book's sections are pages (PDF, photos, and translations of those) rather than chapters.
export function isPaged(book: Pick<Book, 'format' | 'sourceFormat'>) {
  const format = book.format === 'translation' ? book.sourceFormat : book.format;
  return format === 'pdf' || format === 'images';
}

// Languages offered as translation targets: supported both by Apple's Translation framework and by ML Kit.
export const TRANSLATION_TARGETS = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'ar'];
