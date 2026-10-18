import { createAudioPlaylist, type AudioPlaylist, type AudioPlaylistStatus } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import type { Position } from '@/db/database';
import { speechLocale } from '@/lib/text';
import { SpeechFile } from '../../modules/speech-file';
import { BaseNarrator } from './BaseNarrator';

// Sentences rendered ahead of the one playing: the native queue keeps going for a minute or more even if JS is suspended.
const AHEAD = 10;
// Played files kept around so the lock-screen "previous" button still has audio to go back to.
const KEEP_BEHIND = 4;

type Item = { pos: Position; file: File; sectionTitle: string };

// Renders sentences to audio files and plays them through a native playlist: real pause on every platform,
// lock-screen and headset controls, background playback and instant speed changes.
export class AudioNarrator extends BaseNarrator {
  private playlist: AudioPlaylist | null = null;
  private items: Item[] = [];
  private cursor: Position | null = null;
  private filling = false;
  private starved = false;
  private atEnd = false;
  private dir = new Directory(Paths.cache, 'speech');
  private lockScreenTitle = '';

  private ensurePlaylist() {
    if (this.playlist) return this.playlist;
    const playlist = createAudioPlaylist({ sources: [], loop: 'none', updateInterval: 200 });
    playlist.playbackRate = this.voice.rate;
    playlist.addListener('trackChanged', ({ currentIndex }) => this.onTrack(currentIndex));
    playlist.addListener('playlistStatusUpdate', (s) => this.onStatus(s));
    this.playlist = playlist;
    return playlist;
  }

  protected halt() {
    this.session++;
    this.cursor = null;
    this.starved = false;
    this.atEnd = false;
    void SpeechFile?.cancelPending();
    if (this.playlist) {
      this.playlist.pause();
      this.playlist.clear();
    }
    const old = this.items;
    this.items = [];
    old.forEach((i) => safeDelete(i.file));
  }

  pause = () => {
    this.playlist?.pause();
    this.set({ playing: false, buffering: false });
  };

  play = () => {
    const item = this.currentItem();
    const { position } = this.state;
    if (this.playlist && item && samePos(item.pos, position)) {
      this.set({ playing: true });
      this.playlist.play();
      return;
    }
    void this.startFrom(position);
  };

  protected applyRate(rate: number) {
    if (this.playlist) this.playlist.playbackRate = rate;
  }

  dispose() {
    this.halt();
    this.playlist?.clearLockScreenControls();
    this.playlist?.destroy();
    this.playlist = null;
  }

  private currentItem(): Item | undefined {
    return this.playlist ? this.items[this.playlist.currentIndex] : undefined;
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
    this.ensurePlaylist();
    void this.fill(session);
  }

  private async fill(session: number) {
    if (this.filling) return;
    this.filling = true;
    try {
      while (session === this.session && this.cursor) {
        const playing = this.playlist?.currentIndex ?? 0;
        if (this.items.length - playing > AHEAD) break;
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
        let written = false;
        try {
          const res = await SpeechFile!.synthesize(this.spoken(section.sentences[pos.sentenceIdx]), file.uri, {
            voiceId: this.voice.voice,
            language: speechLocale(this.voice.language),
            pitch: this.voice.pitch,
          });
          written = res.written;
        } catch {
          written = false;
        }
        if (session !== this.session) {
          safeDelete(file);
          return;
        }
        if (!written) {
          safeDelete(file);
          continue;
        }
        this.append({ pos, file, sectionTitle: section.title });
      }
    } finally {
      this.filling = false;
    }
    if (session === this.session && this.atEnd && this.starved) this.finish();
  }

  private append(item: Item) {
    const playlist = this.playlist!;
    this.items.push(item);
    playlist.add({ uri: item.file.uri });
    const index = this.items.length - 1;
    if (index === 0) {
      this.activateLockScreen(item);
      if (this.state.playing) playlist.play();
      this.set({ buffering: false });
    } else if (this.starved) {
      this.starved = false;
      playlist.skipTo(index);
      if (this.state.playing) playlist.play();
      this.set({ buffering: false });
    }
  }

  private onTrack(index: number) {
    const item = this.items[index];
    if (!item) return;
    if (this.sleepDue()) {
      this.set({ sleepAt: null });
      this.pause();
    }
    if (item.pos.sectionIdx !== this.state.position.sectionIdx) void this.show(item.pos.sectionIdx);
    this.commit(item.pos);
    this.updateLockScreen(item);
    for (let i = 0; i < index - KEEP_BEHIND; i++) safeDelete(this.items[i].file);
    void this.fill(this.session);
  }

  private onStatus(s: AudioPlaylistStatus) {
    const progress = s.duration > 0 ? Math.min(1, s.currentTime / s.duration) : 0;
    const patch: Partial<typeof this.state> = {};
    if (Math.abs(progress - this.state.sentenceProgress) > 0.02) patch.sentenceProgress = progress;
    if (s.didJustFinish && s.currentIndex >= this.items.length - 1) {
      if (this.atEnd && !this.filling) {
        this.finish();
        return;
      }
      this.starved = true;
      patch.buffering = true;
    } else if (!this.starved && !this.state.buffering && s.isLoaded && s.playing !== this.state.playing) {
      // Lock screen, headset or Control Center toggled playback.
      patch.playing = s.playing;
    }
    if (Object.keys(patch).length) this.set(patch);
  }

  private finish() {
    this.starved = false;
    this.playlist?.pause();
    this.set({ playing: false, buffering: false, sentenceProgress: 0 });
  }

  private activateLockScreen(item: Item) {
    this.lockScreenTitle = item.sectionTitle;
    this.playlist?.setActiveForLockScreen(
      true,
      { title: item.sectionTitle, artist: this.book.author ?? undefined, albumTitle: this.book.title },
      { showNextTrack: true, showPreviousTrack: true },
    );
  }

  private updateLockScreen(item: Item) {
    if (item.sectionTitle === this.lockScreenTitle) return;
    this.lockScreenTitle = item.sectionTitle;
    this.playlist?.updateLockScreenMetadata({ title: item.sectionTitle, artist: this.book.author ?? undefined, albumTitle: this.book.title });
  }
}

function samePos(a: Position, b: Position) {
  return a.sectionIdx === b.sectionIdx && a.sentenceIdx === b.sentenceIdx;
}

function safeDelete(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {}
}
