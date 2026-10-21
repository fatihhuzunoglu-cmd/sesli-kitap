import { useSyncExternalStore } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getSetting, setSetting } from '@/db/database';
import type { Pronunciation } from '@/lib/text';
import type { CloudProvider } from '@/tts/cloudVoices';

export type ThemeName = 'auto' | 'light' | 'sepia' | 'dark';
export type FontFamily = 'serif' | 'sans';

export type Prefs = {
  rate: number;
  pitch: number;
  voices: Record<string, string>;
  fontSize: number;
  lineHeight: number;
  fontFamily: FontFamily;
  theme: ThemeName;
  pronunciations: Pronunciation[];
  // Server and model per cloud voice provider (their API keys are kept in the keychain).
  cloud: Partial<Record<CloudProvider, { baseUrl?: string; model?: string }>>;
};

const DEFAULTS: Prefs = {
  rate: 1,
  pitch: 1,
  voices: {},
  fontSize: 19,
  lineHeight: 1.55,
  fontFamily: 'serif',
  theme: 'auto',
  pronunciations: [],
  cloud: {},
};

let prefs: Prefs = DEFAULTS;
let db: SQLiteDatabase | null = null;
const listeners = new Set<() => void>();

export async function loadPrefs(database: SQLiteDatabase) {
  db = database;
  const stored = await getSetting<Partial<Prefs>>(database, 'prefs', {});
  prefs = { ...DEFAULTS, ...stored };
  listeners.forEach((l) => l());
}

export function getPrefs() {
  return prefs;
}

export function updatePrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  listeners.forEach((l) => l());
  if (db) void setSetting(db, 'prefs', prefs);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs);
}
