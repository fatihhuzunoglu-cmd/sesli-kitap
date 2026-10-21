import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { Position } from '@/db/database';
import { speechLocale } from '@/lib/text';
import { SpeechFile } from '../../modules/speech-file';
import { BaseNarrator } from './BaseNarrator';
import { cloudSettings } from './cloudSettings';
import { parseCloudVoice, synthesizeCloud } from './cloudVoices';

// Sentences rendered ahead of the one playing, so the next file is always ready the moment one ends.
const AHEAD = 8;
// Status updates right after switching files can still describe the previous one; ignore play/pause changes meanwhile.
const SWITCH_GRACE_MS = 800;
// A sentence normally renders in well under a second; past this the system TTS service is assumed stuck.
const SYNTH_TIMEOUT_MS = 20000;
// A cloud voice that does not answer in time is skipped for this long, reading on with the phone's own voice.
const CLOUD_TIMEOUT_MS = 30000;
const CLOUD_RETRY_AFTER_MS = 60000;
// How long a play/pause change from outside the app (lock screen, headset) must last before it is followed.
const EXTERNAL_HOLD_MS = 500;

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
  private external: { playing: boolean; since: number } | null = null;
  private cloudDownUntil = 0;
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
    // Status updates already on their way may still say "playing"; they must not undo the pause.
    this.switchedAt = Date.now();
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

  setVoice(v: Parameters<BaseNarrator['setVoice']>[0]) {
    // A newly chosen voice gets a fresh chance even if the previous cloud voice was failing.
    if (v.voice !== this.voice.voice) this.cloudDownUntil = 0;
    super.setVoice(v);
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
    // Shown as playing (buffering) right away: the first page may still be waiting for OCR or translation.
    this.set({ playing: true, buffering: true });
    const pos = await this.normalise(from, session);
    if (session !== this.session) return;
    if (!pos || !this.state.playing) {
      this.set({ playing: false, buffering: false });
      return;
    }
    await this.show(pos.sectionIdx);
    this.commit(pos);
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
        const pos = await this.normalise(this.cursor, session);
        if (session !== this.session) return;
        if (!pos) {
          this.cursor = null;
          this.atEnd = true;
          break;
        }
        const section = (await this.fetch(pos.sectionIdx))!;
        this.cursor = { sectionIdx: pos.sectionIdx, sentenceIdx: pos.sentenceIdx + 1 };
        const file = await this.render(this.spoken(section.sentences[pos.sentenceIdx]), `${session}-${pos.sectionIdx}-${pos.sentenceIdx}`);
        if (session !== this.session) {
          if (file) safeDelete(file);
          return;
        }
        if (!file) continue;
        this.queue.push({ pos, file, sectionTitle: section.title });
        if (this.starved) this.advance();
      }
    } finally {
      this.filling = false;
    }
    if (session === this.session && this.atEnd && this.starved && !this.queue.length) this.finish();
  }

  // Renders one sentence to an audio file named `name` (plus extension); null when it could not be spoken.
  private async render(text: string, name: string): Promise<File | null> {
    const cloud = parseCloudVoice(this.voice.voice);
    if (cloud && Date.now() >= this.cloudDownUntil) {
      let file: File | null = null;
      try {
        const settings = await cloudSettings(cloud.provider);
        const audio = await withTimeout(synthesizeCloud(settings, cloud.voiceId, text, speechLocale(this.voice.language)), CLOUD_TIMEOUT_MS);
        file = new File(this.dir, `${name}.${audio.ext}`);
        await writeBytes(file, audio.bytes);
        if (this.state.notice) this.set({ notice: null });
        return file;
      } catch (e) {
        if (file) safeDelete(file);
        this.cloudDownUntil = Date.now() + CLOUD_RETRY_AFTER_MS;
        const reason = e instanceof Error && e.message !== 'timeout' ? e.message : 'Yanıt gelmedi.';
        this.set({ notice: `Yapay zekâ sesine ulaşılamadı (${reason}) Telefonun sesiyle devam ediliyor.` });
      }
    }
    // The phone's own voice: the chosen one, or the language's default while a cloud voice is unavailable.
    const file = new File(this.dir, `${name}.${SpeechFile!.fileExtension}`);
    const options = { voiceId: cloud ? null : this.voice.voice, language: speechLocale(this.voice.language), pitch: this.voice.pitch };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await withTimeout(SpeechFile!.synthesize(text, file.uri, options), SYNTH_TIMEOUT_MS);
        if (res.written) return file;
        break;
      } catch {
        await SpeechFile!.reset().catch(() => {});
      }
    }
    safeDelete(file);
    return null;
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
    // A file that is just ending briefly reports "not playing" before "finished"; that is not a user's pause.
    const ending = s.duration > 0 && s.duration - s.currentTime < 0.35;
    if (settled && !this.starved && !ending && s.isLoaded && s.playing !== this.state.playing) {
      // Lock screen, headset or Control Center toggled playback; believe it once it has held for a moment.
      if (this.external?.playing !== s.playing) this.external = { playing: s.playing, since: Date.now() };
      else if (Date.now() - this.external.since >= EXTERNAL_HOLD_MS) {
        patch.playing = s.playing;
        this.external = null;
      }
    } else {
      this.external = null;
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

async function writeBytes(file: File, bytes: Uint8Array) {
  file.create({ overwrite: true });
  const handle = file.open(FileMode.ReadWrite);
  try {
    await handle.writeBytes(bytes);
  } finally {
    handle.close();
  }
}

function safeDelete(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {}
}
