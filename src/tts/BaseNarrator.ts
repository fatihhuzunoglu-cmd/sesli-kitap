import type { SQLiteDatabase } from 'expo-sqlite';
import { getSection, savePosition, type Position, type Section } from '@/db/database';
import { applyPronunciations, toParagraphs, type Paragraph, type Pronunciation } from '@/lib/text';

export type LoadedSection = Section & { paragraphs: Paragraph[]; sentences: string[] };
export type VoiceOptions = { language: string; voice: string | null; pitch: number; rate: number };
export type NarratorState = {
  section: LoadedSection | null;
  position: Position;
  playing: boolean;
  buffering: boolean;
  sleepAt: number | null;
  // Fraction of the current sentence already spoken, used to follow the spoken word.
  sentenceProgress: number;
};
export type BookInfo = { id: string; title: string; author: string | null };

export abstract class BaseNarrator {
  protected state: NarratorState = {
    section: null,
    position: { sectionIdx: 0, sentenceIdx: 0 },
    playing: false,
    buffering: false,
    sleepAt: null,
    sentenceProgress: 0,
  };
  private listeners = new Set<() => void>();
  private cache = new Map<number, LoadedSection | null>();
  protected session = 0;
  protected pronunciations: Pronunciation[] = [];

  constructor(
    protected db: SQLiteDatabase,
    protected book: BookInfo,
    protected sectionCount: number,
    protected voice: VoiceOptions,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getState = () => this.state;

  protected set(patch: Partial<NarratorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  setSectionCount(n: number) {
    if (n !== this.sectionCount) this.cache.clear();
    this.sectionCount = n;
  }

  setBook(book: BookInfo) {
    this.book = book;
  }

  setPronunciations(list: Pronunciation[]) {
    this.pronunciations = list;
  }

  setSleepAt(at: number | null) {
    this.set({ sleepAt: at });
  }

  protected sleepDue() {
    return this.state.sleepAt !== null && Date.now() >= this.state.sleepAt;
  }

  protected spoken(text: string) {
    return applyPronunciations(text, this.pronunciations);
  }

  protected async fetch(idx: number): Promise<LoadedSection | null> {
    if (this.cache.has(idx)) return this.cache.get(idx)!;
    const s = await getSection(this.db, this.book.id, idx);
    let loaded: LoadedSection | null = null;
    if (s) {
      const paragraphs = toParagraphs(s.text);
      loaded = { ...s, paragraphs, sentences: paragraphs.flatMap((p) => p.sentences) };
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(idx, loaded);
    }
    return loaded;
  }

  protected async show(idx: number) {
    const loaded = await this.fetch(idx);
    if (this.state.section !== loaded) this.set({ section: loaded });
    return loaded;
  }

  protected commit(pos: Position, progress = 0) {
    this.set({ position: pos, sentenceProgress: progress });
    void savePosition(this.db, this.book.id, pos);
  }

  protected clamp(idx: number) {
    return Math.max(0, Math.min(this.sectionCount - 1, idx));
  }

  // First readable sentence at or after pos, skipping empty and scanned sections; null at the end of the book.
  protected async normalise(pos: Position): Promise<Position | null> {
    let { sectionIdx, sentenceIdx } = pos;
    for (;;) {
      if (sectionIdx >= this.sectionCount) return null;
      const s = await this.fetch(sectionIdx);
      if (!s) return null;
      if (sentenceIdx < s.sentences.length) return { sectionIdx, sentenceIdx };
      sectionIdx++;
      sentenceIdx = 0;
    }
  }

  protected async stepBack(pos: Position): Promise<Position> {
    if (pos.sentenceIdx > 0) return { sectionIdx: pos.sectionIdx, sentenceIdx: pos.sentenceIdx - 1 };
    for (let idx = pos.sectionIdx - 1; idx >= 0; idx--) {
      const s = await this.fetch(idx);
      if (s && s.sentences.length) return { sectionIdx: idx, sentenceIdx: s.sentences.length - 1 };
    }
    return pos;
  }

  async initialise(pos: Position) {
    const idx = this.clamp(pos.sectionIdx);
    const loaded = await this.show(idx);
    const sentence = loaded ? Math.min(pos.sentenceIdx, Math.max(0, loaded.sentences.length - 1)) : 0;
    this.set({ position: { sectionIdx: idx, sentenceIdx: sentence } });
  }

  play = () => {
    void this.startFrom(this.state.position);
  };

  playSentence = (sentenceIdx: number) => {
    void this.startFrom({ sectionIdx: this.state.position.sectionIdx, sentenceIdx });
  };

  nextSentence = () => {
    const { sectionIdx, sentenceIdx } = this.state.position;
    void this.jump({ sectionIdx, sentenceIdx: sentenceIdx + 1 });
  };

  previousSentence = async () => {
    void this.jump(await this.stepBack(this.state.position));
  };

  goToSection = async (idx: number) => {
    await this.jump({ sectionIdx: this.clamp(idx), sentenceIdx: 0 });
  };

  goTo = async (pos: Position) => {
    await this.jump({ sectionIdx: this.clamp(pos.sectionIdx), sentenceIdx: pos.sentenceIdx });
  };

  private async jump(target: Position) {
    if (this.state.playing) {
      await this.startFrom(target);
      return;
    }
    this.halt();
    const pos = (await this.normalise(target)) ?? target;
    await this.show(pos.sectionIdx);
    this.commit(pos);
  }

  setVoice(v: VoiceOptions) {
    const prev = this.voice;
    this.voice = v;
    const resynth = v.language !== prev.language || v.voice !== prev.voice || v.pitch !== prev.pitch;
    if (resynth && this.state.playing) this.play();
    else if (v.rate !== prev.rate) this.applyRate(v.rate);
  }

  abstract pause: () => void;
  protected abstract startFrom(pos: Position): Promise<void>;
  protected abstract halt(): void;
  protected abstract applyRate(rate: number): void;
  abstract dispose(): void;
}
