import type { SQLiteDatabase } from 'expo-sqlite';
import { getSectionsRange } from '@/db/database';
import { toParagraphs } from './text';

export type SearchHit = { sectionIdx: number; sentenceIdx: number; sectionTitle: string; before: string; match: string; after: string };

const fold = (s: string) => s.toLocaleLowerCase('tr');

export async function searchBook(
  db: SQLiteDatabase,
  bookId: string,
  sectionCount: number,
  query: string,
  isCancelled: () => boolean,
  max = 150,
): Promise<SearchHit[]> {
  const needle = fold(query.trim());
  if (needle.length < 2) return [];
  const hits: SearchHit[] = [];
  for (let from = 0; from < sectionCount && hits.length < max; from += 40) {
    if (isCancelled()) return hits;
    const rows = await getSectionsRange(db, bookId, from, from + 39);
    for (const row of rows) {
      if (!fold(row.text).includes(needle)) continue;
      const sentences = toParagraphs(row.text).flatMap((p) => p.sentences);
      sentences.forEach((sentence, i) => {
        if (hits.length >= max) return;
        const at = fold(sentence).indexOf(needle);
        if (at < 0) return;
        hits.push({
          sectionIdx: row.idx,
          sentenceIdx: i,
          sectionTitle: row.title,
          before: sentence.slice(Math.max(0, at - 40), at),
          match: sentence.slice(at, at + needle.length),
          after: sentence.slice(at + needle.length, at + needle.length + 60),
        });
      });
    }
  }
  return hits;
}
