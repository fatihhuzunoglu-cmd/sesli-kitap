import { Directory, File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { insertBook, insertSections, updateBook } from '@/db/database';
import type { AudioBookInfo } from './catalog';
import { booksDir, newId } from './importBooks';

// An audiobook is a folder of audio files, one section per chapter. A section's text holds where the chapter comes
// from ({ url, seconds }); needs_ocr = 1 marks a chapter not downloaded yet, which plays from the internet meanwhile.
// The reading position stores the chapter as section and the second within it as sentence.

export type Track = { idx: number; title: string; url: string; seconds: number | null; downloaded: boolean };

export function parseTrack(row: { idx: number; title: string; text: string; needs_ocr?: number; ocrPending?: boolean }): Track {
  let data: { url?: string; seconds?: number | null } = {};
  try {
    data = JSON.parse(row.text);
  } catch {}
  const pending = row.ocrPending ?? row.needs_ocr === 1;
  return { idx: row.idx, title: row.title, url: data.url ?? '', seconds: data.seconds ?? null, downloaded: !pending };
}

function extensionOf(url: string) {
  const m = url.split(/[?#]/)[0].match(/\.(mp3|m4a|m4b|aac|ogg|opus|wav|flac)$/i);
  return m ? m[1].toLowerCase() : 'mp3';
}

export function trackFile(bookUri: string, track: Pick<Track, 'idx' | 'url'>) {
  return new File(new Directory(bookUri), `${String(track.idx + 1).padStart(4, '0')}.${extensionOf(track.url)}`);
}

// Where a chapter plays from: the downloaded file, or the internet while it is still downloading.
export function trackSource(bookUri: string, track: Track) {
  if (track.downloaded) {
    const f = trackFile(bookUri, track);
    if (f.exists) return f.uri;
  }
  return track.url;
}

export async function createAudioBook(db: SQLiteDatabase, info: AudioBookInfo): Promise<string> {
  if (!info.tracks.length) throw new Error('Bu sesli kitapta dinlenecek bölüm yok.');
  const id = newId();
  const dir = new Directory(booksDir(), id);
  dir.create({ intermediates: true, idempotent: true });
  await insertBook(db, { id, title: info.title, author: info.author, language: info.language ?? 'tr', format: 'audio', fileUri: dir.uri, size: 0 });
  await insertSections(
    db,
    id,
    info.tracks.map((t, idx) => ({ idx, title: t.title, text: JSON.stringify({ url: t.url, seconds: t.seconds }), ocr: 1 })),
  );
  await updateBook(db, id, { section_count: info.tracks.length });
  return id;
}
