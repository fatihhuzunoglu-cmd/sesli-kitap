import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import Slider from '@react-native-community/slider';
import Ionicons from '@expo/vector-icons/Ionicons';
import { getBook, getPosition, getSectionsRange, savePosition, updateBook, type Book } from '@/db/database';
import { getOcrProgress, useBooksChanged } from '@/engine/booksEvents';
import { useExtractor } from '@/engine/ExtractorProvider';
import { parseTrack, trackSource, type Track } from '@/lib/audioBooks';
import { formatDuration } from '@/lib/catalog';
import { useTheme, type Theme } from '@/ui/theme';

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export default function AudioBookScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const [book, setBook] = useState<Book | null>(null);
  const [tracks, setTracks] = useState<Track[] | null>(null);

  const reload = useCallback(() => {
    void getBook(db, id).then(async (b) => {
      setBook(b);
      if (!b) return;
      const rows = await getSectionsRange(db, id, 0, Math.max(0, b.sectionCount - 1));
      const pending = new Set(b.ocrPendingCount ? (await db.getAllAsync<{ idx: number }>('SELECT idx FROM sections WHERE book_id = ? AND needs_ocr = 1', id)).map((r) => r.idx) : []);
      setTracks(rows.map((r) => parseTrack({ ...r, ocrPending: pending.has(r.idx) })));
    });
  }, [db, id]);

  useEffect(() => {
    reload();
    void updateBook(db, id, { last_opened_at: Date.now() });
  }, [db, id, reload]);
  useBooksChanged(reload, 2000);

  if (!book || !tracks) return <ActivityIndicator style={{ marginTop: 48 }} />;
  return <Player book={book} tracks={tracks} />;
}

function Player({ book, tracks }: { book: Book; tracks: Track[] }) {
  const db = useSQLiteContext();
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const insets = useSafeAreaInsets();
  const extractor = useExtractor();
  const player = useAudioPlayer(null, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<number | null>(null);
  const [rate, setRate] = useState(1);
  const [seeking, setSeeking] = useState<number | null>(null);
  const [wantPlay, setWantPlay] = useState(false);
  const lockScreen = useRef(false);
  const tracksRef = useRef(tracks);
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  const load = useCallback(
    (idx: number, at: number, play: boolean) => {
      const track = tracksRef.current[idx];
      if (!track) return;
      setCurrent(idx);
      setWantPlay(play);
      player.pause();
      player.replace({ uri: trackSource(book.fileUri, track) });
      // The player swaps the file on its own thread after replace() returns; seeking or starting before that would
      // act on the chapter being left. (If starting still does not take, the watchdog below starts it.)
      setTimeout(() => {
        if (at > 0) void player.seekTo(at);
        if (play) player.play();
      }, 300);
      void savePosition(db, book.id, { sectionIdx: idx, sentenceIdx: Math.floor(at) });
      extractor.focus(book.id, idx);
      const metadata = { title: track.title, artist: book.author ?? undefined, albumTitle: book.title };
      try {
        if (lockScreen.current) player.updateLockScreenMetadata(metadata);
        else player.setActiveForLockScreen(true, metadata, { showSeekForward: true, showSeekBackward: true });
        lockScreen.current = true;
      } catch {}
    },
    [player, book.fileUri, book.id, book.title, book.author, db, extractor],
  );

  // Opens where the listener left off.
  useEffect(() => {
    void getPosition(db, book.id).then((pos) => {
      const idx = pos && pos.sectionIdx < tracksRef.current.length ? pos.sectionIdx : 0;
      load(idx, pos?.sentenceIdx ?? 0, false);
    });
    // Only on opening; later track changes go through load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps playing what the listener asked to play: if the player is loaded and idle for a moment though it should
  // be playing (a chapter switch that did not start), it is started again.
  const stalled = wantPlay && status.isLoaded && !status.playing && !status.isBuffering && !status.didJustFinish;
  useEffect(() => {
    if (!stalled) return;
    const timer = setTimeout(() => player.play(), 1500);
    return () => clearTimeout(timer);
  }, [stalled, player]);

  useEffect(() => {
    player.setPlaybackRate(rate, 'high');
  }, [player, rate, status.isLoaded]);

  // The next chapter follows on its own.
  useEffect(() => {
    if (!status.didJustFinish || current === null) return;
    if (current + 1 < tracksRef.current.length) load(current + 1, 0, true);
    else {
      setWantPlay(false);
      void savePosition(db, book.id, { sectionIdx: current, sentenceIdx: 0 });
    }
  }, [status.didJustFinish, current, load, db, book.id]);

  // The position is saved every few seconds while playing, and when leaving.
  const second = Math.floor(status.currentTime / 5);
  useEffect(() => {
    if (current !== null && status.playing) void savePosition(db, book.id, { sectionIdx: current, sentenceIdx: Math.floor(status.currentTime) });
    // Saves on each five-second step, not on every status update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [second, current]);
  useEffect(
    () => () => {
      try {
        player.clearLockScreenControls();
        lockScreen.current = false;
      } catch {}
    },
    [player],
  );

  const toggle = () => {
    if (status.playing) {
      player.pause();
      setWantPlay(false);
      if (current !== null) void savePosition(db, book.id, { sectionIdx: current, sentenceIdx: Math.floor(status.currentTime) });
    } else {
      if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.5)) void player.seekTo(0);
      player.play();
      setWantPlay(true);
    }
  };

  const skip = (delta: number) => {
    const to = Math.max(0, Math.min(status.duration || Infinity, status.currentTime + delta));
    void player.seekTo(to);
  };

  const track = current !== null ? tracks[current] : null;
  const duration = status.duration || track?.seconds || 0;
  const position = seeking ?? status.currentTime;
  const progress = getOcrProgress(book.id);
  const downloaded = tracks.filter((tr) => tr.downloaded).length;
  const total = tracks.reduce((sum, tr) => sum + (tr.seconds ?? 0), 0);

  return (
    <View style={[s.root, { paddingBottom: insets.bottom + 12 }]}>
      <Stack.Screen options={{ title: book.title }} />
      <FlatList
        data={tracks}
        keyExtractor={(tr) => String(tr.idx)}
        contentContainerStyle={{ padding: 16, gap: 6 }}
        ListHeaderComponent={
          <View style={{ gap: 4, marginBottom: 8 }}>
            {book.author ? <Text style={s.author}>{book.author}</Text> : null}
            <Text style={s.meta} testID="audio-download-status">
              {tracks.length} bölüm{total ? ` · ${formatDuration(total)}` : ''} ·{' '}
              {downloaded === tracks.length ? 'hepsi telefonda (internetsiz dinlenir)' : progress ? `indiriliyor ${downloaded}/${tracks.length}` : `${downloaded}/${tracks.length} indirildi`}
            </Text>
            {book.status === 'error' && book.error ? <Text style={[s.meta, { color: t.danger }]}>{book.error}</Text> : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => load(item.idx, 0, true)} style={[s.row, item.idx === current && s.rowActive]} testID={`track-${item.idx}`}>
            <Text style={[s.rowNum, item.idx === current && { color: t.accent }]}>{item.idx + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[s.rowTitle, item.idx === current && { color: t.accent }]} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={s.rowMeta}>
                {item.seconds ? formatDuration(item.seconds) : ''}
                {item.downloaded ? '' : `${item.seconds ? ' · ' : ''}internetten`}
              </Text>
            </View>
            {item.downloaded ? <Ionicons name="checkmark-circle" size={18} color={t.muted} /> : <Ionicons name="cloud-outline" size={18} color={t.muted} />}
          </Pressable>
        )}
      />
      <View style={s.panel}>
        <Text style={s.nowTitle} numberOfLines={1} testID="audio-track-title">
          {track?.title ?? ''}
        </Text>
        <Slider
          minimumValue={0}
          maximumValue={Math.max(1, duration)}
          value={Math.min(position, Math.max(1, duration))}
          onValueChange={setSeeking}
          onSlidingComplete={(v) => {
            setSeeking(null);
            void player.seekTo(v);
          }}
          minimumTrackTintColor={t.accent}
          maximumTrackTintColor={t.border}
          thumbTintColor={t.accent}
          testID="audio-seek"
        />
        <View style={s.times}>
          <Text style={s.time} testID="audio-time">
            {formatDuration(position)}
          </Text>
          <Text style={s.time}>{duration ? formatDuration(duration) : '--:--'}</Text>
        </View>
        <View style={s.transport}>
          <Pressable onPress={() => current !== null && current > 0 && load(current - 1, 0, status.playing)} hitSlop={10} accessibilityLabel="Önceki bölüm" testID="audio-prev">
            <Ionicons name="play-skip-back" size={26} color={t.text} />
          </Pressable>
          <Pressable onPress={() => skip(-15)} hitSlop={10} accessibilityLabel="15 saniye geri" testID="audio-back">
            <Ionicons name="play-back" size={30} color={t.text} />
          </Pressable>
          <Pressable onPress={toggle} style={s.play} accessibilityRole="button" accessibilityLabel={status.playing ? 'Duraklat' : 'Dinle'} testID="audio-play">
            {status.isBuffering && wantPlay && !status.playing ? (
              <ActivityIndicator color={t.accentText} />
            ) : (
              <Ionicons name={status.playing ? 'pause' : 'play'} size={34} color={t.accentText} style={status.playing ? undefined : { marginLeft: 4 }} />
            )}
          </Pressable>
          <Pressable onPress={() => skip(30)} hitSlop={10} accessibilityLabel="30 saniye ileri" testID="audio-forward">
            <Ionicons name="play-forward" size={30} color={t.text} />
          </Pressable>
          <Pressable
            onPress={() => current !== null && current + 1 < tracks.length && load(current + 1, 0, status.playing)}
            hitSlop={10}
            accessibilityLabel="Sonraki bölüm"
            testID="audio-next"
          >
            <Ionicons name="play-skip-forward" size={26} color={t.text} />
          </Pressable>
        </View>
        <Pressable onPress={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])} style={s.rate} testID="audio-rate">
          <Ionicons name="speedometer-outline" size={16} color={t.muted} />
          <Text style={s.rateText}>{String(rate).replace('.', ',')}× hız</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    author: { fontSize: 16, color: t.text, fontWeight: '600' },
    meta: { fontSize: 13, color: t.muted },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: t.surface },
    rowActive: { borderWidth: 1, borderColor: t.accent },
    rowNum: { width: 28, textAlign: 'right', color: t.muted, fontVariant: ['tabular-nums'] },
    rowTitle: { fontSize: 15, color: t.text },
    rowMeta: { fontSize: 12, color: t.muted },
    panel: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border, paddingHorizontal: 16, paddingTop: 12, gap: 4, backgroundColor: t.surface },
    nowTitle: { fontSize: 16, fontWeight: '600', color: t.text, textAlign: 'center' },
    times: { flexDirection: 'row', justifyContent: 'space-between' },
    time: { fontSize: 12, color: t.muted, fontVariant: ['tabular-nums'] },
    transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', paddingVertical: 6 },
    play: { width: 68, height: 68, borderRadius: 34, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    rate: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: t.border },
    rateText: { fontSize: 13, color: t.muted },
  });
