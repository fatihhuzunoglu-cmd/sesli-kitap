import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Narrator, type VoiceOptions } from './Narrator';

export type { LoadedSection } from './Narrator';

export function useNarrator(db: SQLiteDatabase, bookId: string, sectionCount: number, voice: VoiceOptions) {
  const [narrator] = useState(() => new Narrator(db, bookId, sectionCount, voice));
  const state = useSyncExternalStore(narrator.subscribe, narrator.getState);

  useEffect(() => narrator.setSectionCount(sectionCount), [narrator, sectionCount]);
  useEffect(() => narrator.setVoice(voice), [narrator, voice.language, voice.rate, voice.voice]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => narrator.dispose(), [narrator]);

  return { narrator, ...state };
}
