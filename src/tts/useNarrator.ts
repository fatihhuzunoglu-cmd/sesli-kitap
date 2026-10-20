import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Pronunciation } from '@/lib/text';
import { SpeechFile } from '../../modules/speech-file';
import { AudioNarrator } from './AudioNarrator';
import type { BaseNarrator, BookInfo, VoiceOptions } from './BaseNarrator';
import { LiveNarrator } from './LiveNarrator';

export type { LoadedSection } from './BaseNarrator';

export const usesAudioPipeline = SpeechFile != null;

export function useNarrator(
  db: SQLiteDatabase,
  book: BookInfo,
  sectionCount: number,
  voice: VoiceOptions,
  pronunciations: Pronunciation[],
  processing: boolean,
) {
  const [narrator] = useState<BaseNarrator>(() =>
    usesAudioPipeline ? new AudioNarrator(db, book, sectionCount, voice) : new LiveNarrator(db, book, sectionCount, voice),
  );
  const state = useSyncExternalStore(narrator.subscribe, narrator.getState);

  useEffect(() => narrator.setSectionCount(sectionCount), [narrator, sectionCount]);
  useEffect(() => narrator.setBook(book), [narrator, book.id, book.title, book.author]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => narrator.setPronunciations(pronunciations), [narrator, pronunciations]);
  useEffect(() => narrator.setProcessing(processing), [narrator, processing]);
  useEffect(
    () => narrator.setVoice(voice),
    [narrator, voice.language, voice.voice, voice.pitch, voice.rate], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => () => narrator.dispose(), [narrator]);

  return { narrator, ...state };
}
