import * as Speech from 'expo-speech';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getSection, savePosition, type Position, type Section } from '@/db/database';
import { speechLocale, toParagraphs, type Paragraph } from '@/lib/text';

// Sentences queued ahead of the one being spoken, so speech keeps flowing if JS is throttled in the background.
const LOOKAHEAD = 6;

export type LoadedSection = Section & { paragraphs: Paragraph[]; sentences: string[] };
export type VoiceOptions = { language: string; rate: number; voice: string | null };
export type NarratorState = {
  section: LoadedSection | null;
  position: Position;
  playing: boolean;
  sleepAt: number | null;
};

// Speaks a book sentence by sentence and persists the current sentence, so stopping (Android has no pause) never loses the place.
export class Narrator {
  private state: NarratorState = { section: null, position: { sectionIdx: 0, sentenceIdx: 0 }, playing: false, sleepAt: null };
  private listeners = new Set<() => void>();
  private session = 0;
  private queuedUntil = -1;

  constructor(
    private db: SQLiteDatabase,
    private bookId: string,
    private sectionCount: number,
    private voice: VoiceOptions,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = () => this.state;

  private set(patch: Partial<NarratorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  setSectionCount(n: number) {
    this.sectionCount = n;
  }

  setVoice(v: VoiceOptions) {
    const changed = v.language !== this.voice.language || v.rate !== this.voice.rate || v.voice !== this.voice.voice;
    this.voice = v;
    if (changed && this.state.playing) this.play();
  }

  setSleepAt(at: number | null) {
    this.set({ sleepAt: at });
  }

  private async load(idx: number): Promise<LoadedSection | null> {
    const s = await getSection(this.db, this.bookId, idx);
    let loaded: LoadedSection | null = null;
    if (s) {
      const paragraphs = toParagraphs(s.text);
      loaded = { ...s, paragraphs, sentences: paragraphs.flatMap((p) => p.sentences) };
    }
    this.set({ section: loaded });
    return loaded;
  }

  private commit(pos: Position) {
    this.set({ position: pos });
    void savePosition(this.db, this.bookId, pos);
  }

  private clamp(idx: number) {
    return Math.max(0, Math.min(this.sectionCount - 1, idx));
  }

  async initialise(pos: Position) {
    const idx = this.clamp(pos.sectionIdx);
    const loaded = await this.load(idx);
    const sentence = loaded ? Math.min(pos.sentenceIdx, Math.max(0, loaded.sentences.length - 1)) : 0;
    this.set({ position: { sectionIdx: idx, sentenceIdx: sentence } });
  }

  private stopSpeech() {
    this.session++;
    this.queuedUntil = -1;
    void Speech.stop();
  }

  pause = () => {
    this.stopSpeech();
    this.set({ playing: false });
  };

  play = () => {
    void this.speakFrom(this.state.position.sectionIdx, this.state.position.sentenceIdx);
  };

  playSentence = (sentenceIdx: number) => {
    void this.speakFrom(this.state.position.sectionIdx, sentenceIdx);
  };

  goToSection = async (idx: number) => {
    const wasPlaying = this.state.playing;
    this.stopSpeech();
    const target = this.clamp(idx);
    await this.load(target);
    this.commit({ sectionIdx: target, sentenceIdx: 0 });
    if (wasPlaying) void this.speakFrom(target, 0);
    else this.set({ playing: false });
  };

  dispose() {
    this.stopSpeech();
  }

  private async speakFrom(sectionIdx: number, sentenceIdx: number) {
    this.stopSpeech();
    const session = this.session;

    let idx = sectionIdx;
    let sentence = sentenceIdx;
    let loaded = this.state.section?.idx === idx ? this.state.section : await this.load(idx);
    while (loaded && sentence >= loaded.sentences.length && session === this.session) {
      if (idx + 1 >= this.sectionCount) {
        this.set({ playing: false });
        return;
      }
      idx++;
      sentence = 0;
      loaded = await this.load(idx);
    }
    if (session !== this.session) return;
    if (!loaded) {
      this.set({ playing: false });
      return;
    }
    const current = loaded;
    this.set({ playing: true });
    this.commit({ sectionIdx: idx, sentenceIdx: sentence });

    const enqueue = (i: number) => {
      const { language, rate, voice } = this.voice;
      this.queuedUntil = i;
      Speech.speak(current.sentences[i], {
        language: speechLocale(language),
        rate,
        voice: voice ?? undefined,
        useApplicationAudioSession: true,
        onStart: () => {
          if (session !== this.session) return;
          if (this.state.sleepAt && Date.now() >= this.state.sleepAt) {
            this.set({ sleepAt: null });
            this.pause();
            return;
          }
          this.commit({ sectionIdx: idx, sentenceIdx: i });
          topUp(i);
        },
        onDone: () => {
          if (session !== this.session) return;
          if (i === current.sentences.length - 1) void this.speakFrom(idx + 1, 0);
        },
        onError: () => {
          if (session !== this.session) return;
          if (i === this.queuedUntil) void this.speakFrom(idx, i + 1);
        },
      });
    };
    const topUp = (from: number) => {
      const last = Math.min(current.sentences.length - 1, from + LOOKAHEAD);
      for (let i = this.queuedUntil + 1; i <= last; i++) enqueue(i);
    };
    this.queuedUntil = sentence - 1;
    topUp(sentence);
  }
}
