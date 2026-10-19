import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import type { Position } from '@/db/database';
import { speechLocale } from '@/lib/text';
import { SpeechFile } from '../../modules/speech-file';
import { BaseNarrator } from './BaseNarrator';

// Sentences rendered ahead of the one playing, so the next file is always ready the moment one ends.
const AHEAD = 8;
// Status updates right after switching files can still describe the previous one; ignore play/pause changes meanwhile.
const SWITCH_GRACE_MS = 800;
// A sentence normally renders in well under a second; past this the system TTS service is assumed stuck.
const SYNTH_TIMEOUT_MS = 20000;

type Item = { pos: Position; file: File; sectionTitle: string };

// Renders sentences to audio files and plays them one after another on a single native player.
// A single player (rather than a growing native playlist) keeps Android's media session consistent,
// while still giving real pause, lock-screen/headset play-pause, background playback and instant speed changes.
export class AudioNarrator extends BaseNarrator {
  private player: AudioPlayer | null = null;
  private current: Item | null = null;
  private queue: Item[] = [];
  private cursor: Position | null = null;
  private filling = false;
  private starved = false;
  private atEnd = false;
  private switchedAt = 0;
  private lockScreenActive = false;
  private lockScreenTitle = '';
  private dir = new Directory(Paths.cache, 'speech');

  private ensurePlayer() {
    if (this.player) return this.player;
    const player = createAudioPlayer(null, { updateInterval: 200, keepAudioSessionActive: true });
    player.addListener('playbackStatusUpdate', (s) => this.onStatus(s));
    this.player = player;
    return player;
  }

  protected halt() {
    this.session++;
    this.cursor = null;
    this.starved = false;
    this.atEnd = false;
    void SpeechFile?.cancelPending();
    this.player?.pause();
    const old = [...this.queue, ...(this.current ? [this.current] : [])];
    this.queue = [];
    this.current = null;
    old.forEach((i) => safeDelete(i.file));
  }

  pause = () => {
    this.player?.pause();
    this.set({ playing: false, buffering: false });
  };

  play = () => {
    const { position } = this.state;
    if (this.player && this.current && samePos(this.current.pos, position)) {
      this.set({ playing: true });
      this.player.play();
      return;
    }
    void this.startFrom(position);
  };

  protected applyRate(rate: number) {
    this.player?.setPlaybackRate(rate, 'high');
  }

  dispose() {
    this.halt();
    if (this.player) {
      this.player.clearLockScreenControls();
      this.player.remove();
      this.player = null;
    }
  }

  protected async startFrom(from: Position) {
    this.halt();
    const session = this.session;
    this.dir.create({ idempotent: true, intermediates: true });
    const pos = await this.normalise(from);
    if (session !== this.session) return;
    if (!pos) {
      this.set({ playing: false, buffering: false });
      return;
    }
    await this.show(pos.sectionIdx);
    this.commit(pos);
    this.set({ playing: true, buffering: true });
    this.cursor = pos;
    this.starved = true;
    this.ensurePlayer();
    void this.fill(session);
  }

  private async fill(session: number) {
    if (this.filling) return;
    this.filling = true;
    try {
      while (session === this.session && this.cursor && this.queue.length < AHEAD) {
        const pos = await this.normalise(this.cursor);
        if (session !== this.session) return;
        if (!pos) {
          this.cursor = null;
          this.atEnd = true;
          break;
        }
        const section = (await this.fetch(pos.sectionIdx))!;
        this.cursor = { sectionIdx: pos.sectionIdx, sentenceIdx: pos.sentenceIdx + 1 };
        const file = new File(this.dir, `${session}-${pos.sectionIdx}-${pos.sentenceIdx}.${SpeechFile!.fileExtension}`);
        const written = await this.render(this.spoken(section.sentences[pos.sentenceIdx]), file);
        if (session !== this.session) {
          safeDelete(file);
          return;
        }
        if (!written) {
          safeDelete(file);
          continue;
        }
        this.queue.push({ pos, file, sectionTitle: section.title });
        if (this.starved) this.advance();
      }
    } finally {
      this.filling = false;
    }
    if (session === this.session && this.atEnd && this.starved && !this.queue.length) this.finish();
  }

  // Renders one sentence; if the TTS service hangs or dies, restarts it and tries once more before skipping.
  private async render(text: string, file: File): Promise<boolean> {
    const options = { voiceId: this.voice.voice, language: speechLocale(this.voice.language), pitch: this.voice.pitch };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await withTimeout(SpeechFile!.synthesize(text, file.uri, options), SYNTH_TIMEOUT_MS);
        return res.written;
      } catch {
        await SpeechFile!.reset().catch(() => {});
      }
    }
    return false;
  }

  private advance() {
    const next = this.queue.shift();
    if (this.current) safeDelete(this.current.file);
    this.current = next ?? null;
    if (!next) {
      if (this.atEnd) {
        this.finish();
      } else {
        this.starved = true;
        this.set({ buffering: true });
      }
      return;
    }
    this.starved = false;
    const player = this.ensurePlayer();
    this.switchedAt = Date.now();
    player.replace({ uri: next.file.uri });
    player.setPlaybackRate(this.voice.rate, 'high');
    if (this.sleepDue()) {
      this.set({ sleepAt: null });
      this.pause();
    } else if (this.state.playing) {
      player.play();
    }
    if (next.pos.sectionIdx !== this.state.position.sectionIdx) void this.show(next.pos.sectionIdx);
    this.commit(next.pos);
    this.set({ buffering: false });
    this.updateLockScreen(next);
    void this.fill(this.session);
  }

  private onStatus(s: AudioStatus) {
    if (!this.current) return;
    if (s.didJustFinish) {
      // A late "finished" from the previous file must not skip the sentence that just started.
      if (Date.now() - this.switchedAt > 250) this.advance();
      return;
    }
    const patch: Partial<typeof this.state> = {};
    const progress = s.duration > 0 ? Math.min(1, s.currentTime / s.duration) : 0;
    if (Math.abs(progress - this.state.sentenceProgress) > 0.02) patch.sentenceProgress = progress;
    const settled = Date.now() - this.switchedAt > SWITCH_GRACE_MS;
    if (settled && !this.starved && s.isLoaded && s.playing !== this.state.playing) {
      // Lock screen, headset or Control Center toggled playback.
      patch.playing = s.playing;
    }
    if (Object.keys(patch).length) this.set(patch);
  }

  private finish() {
    this.starved = false;
    this.player?.pause();
    this.set({ playing: false, buffering: false, sentenceProgress: 0 });
  }

  private updateLockScreen(item: Item) {
    const player = this.player;
    if (!player) return;
    const metadata = { title: item.sectionTitle, artist: this.book.author ?? undefined, albumTitle: this.book.title };
    if (!this.lockScreenActive) {
      player.setActiveForLockScreen(true, metadata, { showNextTrack: false, showPreviousTrack: false });
      this.lockScreenActive = true;
      this.lockScreenTitle = item.sectionTitle;
    } else if (item.sectionTitle !== this.lockScreenTitle) {
      player.updateLockScreenMetadata(metadata);
      this.lockScreenTitle = item.sectionTitle;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function samePos(a: Position, b: Position) {
  return a.sectionIdx === b.sectionIdx && a.sentenceIdx === b.sentenceIdx;
}

function safeDelete(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {}
}
