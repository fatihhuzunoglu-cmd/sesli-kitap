import * as Speech from 'expo-speech';
import type { Position } from '@/db/database';
import { speechLocale } from '@/lib/text';
import { BaseNarrator } from './BaseNarrator';

// Sentences queued ahead of the one being spoken, so speech keeps flowing if JS is throttled in the background.
const LOOKAHEAD = 6;

// Live expo-speech playback, used where the SpeechFile native module is unavailable (Expo Go).
// Android has no pause here, so pausing stops speech and resumes from the saved sentence.
export class LiveNarrator extends BaseNarrator {
  private queuedUntil = -1;

  protected halt() {
    this.session++;
    this.queuedUntil = -1;
    void Speech.stop();
  }

  pause = () => {
    this.halt();
    this.set({ playing: false });
  };

  protected applyRate() {
    if (this.state.playing) this.play();
  }

  dispose() {
    this.halt();
  }

  protected async startFrom(from: Position) {
    this.halt();
    const session = this.session;
    const pos = await this.normalise(from);
    if (session !== this.session) return;
    if (!pos) {
      this.set({ playing: false });
      return;
    }
    const current = (await this.show(pos.sectionIdx))!;
    if (session !== this.session) return;
    this.set({ playing: true, buffering: false });
    this.commit(pos);

    const enqueue = (i: number) => {
      const { language, rate, voice, pitch } = this.voice;
      this.queuedUntil = i;
      Speech.speak(this.spoken(current.sentences[i]), {
        language: speechLocale(language),
        rate,
        pitch,
        voice: voice ?? undefined,
        useApplicationAudioSession: true,
        onStart: () => {
          if (session !== this.session) return;
          if (this.sleepDue()) {
            this.set({ sleepAt: null });
            this.pause();
            return;
          }
          this.commit({ sectionIdx: pos.sectionIdx, sentenceIdx: i });
          topUp(i);
        },
        onDone: () => {
          if (session !== this.session) return;
          if (i === current.sentences.length - 1) void this.startFrom({ sectionIdx: pos.sectionIdx + 1, sentenceIdx: 0 });
        },
        onError: () => {
          if (session !== this.session) return;
          if (i === this.queuedUntil) void this.startFrom({ sectionIdx: pos.sectionIdx, sentenceIdx: i + 1 });
        },
      });
    };
    const topUp = (from: number) => {
      const last = Math.min(current.sentences.length - 1, from + LOOKAHEAD);
      for (let i = this.queuedUntil + 1; i <= last; i++) enqueue(i);
    };
    this.queuedUntil = pos.sentenceIdx - 1;
    topUp(pos.sentenceIdx);
  }
}
