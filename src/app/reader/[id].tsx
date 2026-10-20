import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  addBookmark,
  deleteBookmark,
  findBookmark,
  getBook,
  getPosition,
  getSectionTitles,
  listBookmarks,
  updateBook,
  type Book,
  type Bookmark,
} from '@/db/database';
import { useBooksChanged } from '@/engine/booksEvents';
import { useExtractor } from '@/engine/ExtractorProvider';
import { isPaged, TRANSLATION_TARGETS } from '@/lib/books';
import { createTranslation } from '@/lib/importBooks';
import { searchBook, type SearchHit } from '@/lib/search';
import type { Paragraph } from '@/lib/text';
import { languageLabel } from '@/lib/voices';
import { useNarrator, usesAudioPipeline } from '@/tts/useNarrator';
import { updatePrefs, usePrefs, type FontFamily, type ThemeName } from '@/ui/prefs';
import { Sheet } from '@/ui/Sheet';
import { fontFor, useTheme, type Theme } from '@/ui/theme';
import { Translator } from '../../../modules/translator';

const RATE_PRESETS = [0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60, 90];

export default function ReaderScreen() {
  const { id, autoplay } = useLocalSearchParams<{ id: string; autoplay?: string }>();
  const db = useSQLiteContext();
  const [book, setBook] = useState<Book | null>(null);

  const reloadBook = useCallback(() => {
    void getBook(db, id).then(setBook);
  }, [db, id]);

  useEffect(() => {
    reloadBook();
    void updateBook(db, id, { last_opened_at: Date.now() });
  }, [db, id, reloadBook]);

  useBooksChanged(reloadBook);

  if (!book) return <ActivityIndicator style={{ marginTop: 48 }} />;
  return <Reader book={book} autoplay={autoplay === '1'} />;
}

type Panel = null | 'toc' | 'speed' | 'sleep' | 'appearance' | 'translate';

const canTranslate = Translator?.isSupported() ?? false;

function Reader({ book, autoplay }: { book: Book; autoplay: boolean }) {
  const db = useSQLiteContext();
  const t = useTheme();
  const prefs = usePrefs();
  const s = useMemo(() => styles(t), [t]);
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<Paragraph>>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [ready, setReady] = useState(false);
  const [bookmarkId, setBookmarkId] = useState<number | null>(null);
  const extractor = useExtractor();
  const processing = book.status === 'processing';

  const voice = prefs.voices[book.language] ?? null;
  const { narrator, section, position, playing, buffering, sleepAt, sentenceProgress } = useNarrator(
    db,
    { id: book.id, title: book.title, author: book.author },
    book.sectionCount,
    { language: book.language, voice, pitch: prefs.pitch, rate: prefs.rate },
    prefs.pronunciations,
    processing,
  );

  // While pages are still being recognised or translated, the ones being read (or waited for) go first.
  useEffect(() => {
    if (processing) extractor.focus(book.id, position.sectionIdx);
  }, [processing, extractor, book.id, position.sectionIdx]);
  useEffect(() => narrator.onWait((idx) => extractor.focus(book.id, idx)), [narrator, extractor, book.id]);
  useBooksChanged(narrator.refresh);

  useEffect(() => {
    void getPosition(db, book.id).then(async (pos) => {
      await narrator.initialise(pos ?? { sectionIdx: 0, sentenceIdx: 0 });
      setReady(true);
      if (autoplay) narrator.play();
    });
    // Autoplay applies only to the first open of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, book.id, narrator]);

  useEffect(() => {
    let alive = true;
    void findBookmark(db, book.id, position).then((b) => {
      if (alive) setBookmarkId(b?.id ?? null);
    });
    return () => {
      alive = false;
    };
  }, [db, book.id, position]);

  const currentParagraph = useMemo(() => {
    if (!section || !section.paragraphs.length) return -1;
    const ps = section.paragraphs;
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].firstSentence <= position.sentenceIdx) return i;
    return 0;
  }, [section, position.sentenceIdx]);

  // FlatList throws (and crashes release builds) on out-of-range indexes, e.g. pages without text.
  const scrollToParagraph = useCallback((index: number, count: number, animated: boolean) => {
    if (index < 0 || index >= count) return;
    try {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated });
    } catch {}
  }, []);

  const scrolledFor = useRef('');
  useEffect(() => {
    if (!ready || !section || currentParagraph < 0) return;
    const key = `${section.idx}:${currentParagraph}`;
    if (scrolledFor.current === key) return;
    const first = !scrolledFor.current.startsWith(`${section.idx}:`);
    scrolledFor.current = key;
    if (!playing && !first) return;
    const count = section.paragraphs.length;
    requestAnimationFrame(() => scrollToParagraph(currentParagraph, count, !first));
  }, [ready, section, currentParagraph, playing, scrollToParagraph]);

  const toggleBookmark = async () => {
    if (bookmarkId !== null) {
      await deleteBookmark(db, bookmarkId);
      setBookmarkId(null);
      return;
    }
    const excerpt = section?.sentences[position.sentenceIdx] ?? section?.title ?? '';
    await addBookmark(db, book.id, position, excerpt);
    setBookmarkId((await findBookmark(db, book.id, position))?.id ?? null);
  };

  const unit = isPaged(book) ? 'Sayfa' : 'Bölüm';
  const lastSection = book.sectionCount - 1;
  const canNext = position.sectionIdx < lastSection;
  const sentenceCount = section?.sentences.length ?? 0;
  const bookProgress = book.sectionCount ? (position.sectionIdx + (sentenceCount ? position.sentenceIdx / sentenceCount : 0)) / book.sectionCount : 0;
  const now = useNow(sleepAt ? 30_000 : 0);
  const sleepLeft = sleepAt ? Math.max(1, Math.round((sleepAt - now) / 60000)) : 0;
  const textStyle = useMemo(
    () => ({ fontSize: prefs.fontSize, lineHeight: prefs.fontSize * prefs.lineHeight, fontFamily: fontFor(prefs.fontFamily), color: t.text }),
    [prefs.fontSize, prefs.lineHeight, prefs.fontFamily, t.text],
  );

  return (
    <View style={s.root}>
      <Stack.Screen
        options={{
          title: section?.title ?? book.title,
          headerRight: () => (
            <Pressable onPress={() => setPanel('toc')} hitSlop={12} accessibilityRole="button" accessibilityLabel="İçindekiler, yer imleri ve arama" testID="toc-button">
              <Ionicons name="list" size={26} color={t.accent} />
            </Pressable>
          ),
        }}
      />
      {!ready ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={t.accent} />
      ) : (
        <FlatList
          ref={listRef}
          data={section?.paragraphs ?? []}
          keyExtractor={(_, i) => `${section?.idx}-${i}`}
          contentContainerStyle={s.content}
          initialNumToRender={24}
          windowSize={11}
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => scrollToParagraph(info.index, section?.paragraphs.length ?? 0, false), 120);
          }}
          ListEmptyComponent={
            <Text style={s.notice} testID="empty-section">
              {section === null && book.status === 'error'
                ? `${book.format === 'translation' ? 'Çeviri yapılamadı' : 'Kitap işlenemedi'}: ${book.error ?? ''}`
                : section === null
                ? book.format === 'translation' && processing
                  ? 'Bu sayfa çevriliyor… Hazır olunca okunur.'
                  : 'Bu bölüm hâlâ hazırlanıyor…'
                : section.ocrPending && processing
                  ? 'Bu sayfanın metni resimden tanınıyor (OCR)… Hazır olunca okunur.'
                  : section.needsOcr
                    ? 'Bu sayfada okunabilir metin bulunamadı. Sesli okuma bu sayfayı atlar.'
                    : 'Bu bölüm boş.'}
            </Text>
          }
          renderItem={({ item, index }) => (
            <ParagraphView
              paragraph={item}
              activeSentence={index === currentParagraph ? position.sentenceIdx : -1}
              progress={index === currentParagraph && playing && usesAudioPipeline ? sentenceProgress : -1}
              textStyle={textStyle}
              theme={t}
              onPressSentence={narrator.playSentence}
            />
          )}
        />
      )}

      <View style={[s.controls, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <View style={s.progressRow}>
          <Pressable onPress={() => narrator.goToSection(position.sectionIdx - 1)} disabled={position.sectionIdx === 0} hitSlop={10} accessibilityLabel={`Önceki ${unit.toLowerCase()}`} testID="prev-section">
            <Ionicons name="chevron-back" size={22} color={position.sectionIdx === 0 ? t.border : t.accent} />
          </Pressable>
          <View style={{ flex: 1, gap: 4 }}>
            <View style={s.track}>
              <View style={[s.fill, { width: `${Math.min(100, Math.round(bookProgress * 100))}%` }]} />
            </View>
            <Text style={s.where} testID="position-label">
              {unit} {position.sectionIdx + 1}/{book.sectionCount} · Cümle {sentenceCount ? position.sentenceIdx + 1 : 0}/{sentenceCount} · %{Math.round(bookProgress * 100)}
            </Text>
          </View>
          <Pressable onPress={() => narrator.goToSection(position.sectionIdx + 1)} disabled={!canNext} hitSlop={10} accessibilityLabel={`Sonraki ${unit.toLowerCase()}`} testID="next-section">
            <Ionicons name="chevron-forward" size={22} color={canNext ? t.accent : t.border} />
          </Pressable>
        </View>

        <View style={s.transport}>
          <Pressable onPress={narrator.previousSentence} hitSlop={10} accessibilityLabel="Önceki cümle" testID="prev-sentence" style={s.transportBtn}>
            <Ionicons name="play-skip-back" size={28} color={t.text} />
          </Pressable>
          <Pressable
            style={s.playBtn}
            onPress={playing ? narrator.pause : narrator.play}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Duraklat' : 'Sesli oku'}
            testID="play-button"
          >
            {buffering && playing ? (
              <ActivityIndicator color={t.accentText} />
            ) : (
              <Ionicons name={playing ? 'pause' : 'play'} size={34} color={t.accentText} style={playing ? undefined : { marginLeft: 4 }} />
            )}
          </Pressable>
          <Pressable onPress={narrator.nextSentence} hitSlop={10} accessibilityLabel="Sonraki cümle" testID="next-sentence" style={s.transportBtn}>
            <Ionicons name="play-skip-forward" size={28} color={t.text} />
          </Pressable>
        </View>

        <View style={s.toolbar}>
          <Tool theme={t} icon="speedometer" label={`${formatRate(prefs.rate)}×`} onPress={() => setPanel('speed')} testID="speed-button" />
          <Tool
            theme={t}
            icon="person-circle-outline"
            label={languageLabel(book.language)}
            onPress={() => router.push({ pathname: '/voices', params: { language: book.language, bookId: book.id } })}
            testID="voice-button"
          />
          <Tool theme={t} icon="timer-outline" label={sleepAt ? `${sleepLeft} dk` : 'Uyku'} active={!!sleepAt} onPress={() => setPanel('sleep')} testID="sleep-button" />
          <Tool theme={t} icon={bookmarkId !== null ? 'bookmark' : 'bookmark-outline'} label="Yer imi" active={bookmarkId !== null} onPress={toggleBookmark} testID="bookmark-button" />
          <Tool theme={t} icon="text" label="Görünüm" onPress={() => setPanel('appearance')} testID="appearance-button" />
          {canTranslate && book.format !== 'translation' ? (
            <Tool theme={t} icon="language-outline" label="Çevir" onPress={() => setPanel('translate')} testID="translate-button" />
          ) : null}
        </View>
      </View>

      <TocSheet
        visible={panel === 'toc'}
        book={book}
        processing={processing}
        current={position.sectionIdx}
        theme={t}
        onClose={() => setPanel(null)}
        onPick={(pos) => {
          setPanel(null);
          void narrator.goTo(pos);
        }}
      />
      <SpeedSheet visible={panel === 'speed'} rate={prefs.rate} theme={t} onClose={() => setPanel(null)} />
      <SleepSheet
        visible={panel === 'sleep'}
        active={!!sleepAt}
        theme={t}
        onClose={() => setPanel(null)}
        onPick={(minutes) => {
          narrator.setSleepAt(minutes ? Date.now() + minutes * 60_000 : null);
          setPanel(null);
        }}
      />
      <AppearanceSheet visible={panel === 'appearance'} theme={t} onClose={() => setPanel(null)} />
      <TranslateSheet
        visible={panel === 'translate'}
        book={book}
        theme={t}
        onClose={() => setPanel(null)}
        onStart={async (language) => {
          setPanel(null);
          narrator.pause();
          const id = await createTranslation(db, book, language);
          extractor.enqueue(id);
          router.push({ pathname: '/reader/[id]', params: { id, autoplay: '1' } });
        }}
      />
    </View>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, intervalMs);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [intervalMs]);
  return now;
}

function formatRate(r: number) {
  return Number.isInteger(r) ? r.toFixed(1) : String(Math.round(r * 100) / 100);
}

// Index range of the word being spoken, estimated from playback progress through the sentence.
function wordAt(sentence: string, progress: number): [number, number] | null {
  if (progress < 0 || !sentence) return null;
  const at = Math.min(sentence.length - 1, Math.floor(progress * sentence.length));
  let start = at;
  let end = at;
  while (start > 0 && !/\s/.test(sentence[start - 1])) start--;
  while (end < sentence.length && !/\s/.test(sentence[end])) end++;
  return end > start ? [start, end] : null;
}

const ParagraphView = memo(function ParagraphView({
  paragraph,
  activeSentence,
  progress,
  textStyle,
  theme,
  onPressSentence,
}: {
  paragraph: Paragraph;
  activeSentence: number;
  progress: number;
  textStyle: object;
  theme: Theme;
  onPressSentence: (i: number) => void;
}) {
  return (
    <Text style={[textStyle, { marginBottom: 14 }]}>
      {paragraph.sentences.map((sentence, j) => {
        const idx = paragraph.firstSentence + j;
        const space = j < paragraph.sentences.length - 1 ? ' ' : '';
        if (idx !== activeSentence) {
          return (
            <Text key={j} onPress={() => onPressSentence(idx)}>
              {sentence}
              {space}
            </Text>
          );
        }
        const word = wordAt(sentence, progress);
        return (
          <Text key={j} onPress={() => onPressSentence(idx)} style={{ backgroundColor: theme.highlight }} testID="active-sentence">
            {word ? (
              <>
                {sentence.slice(0, word[0])}
                <Text style={{ backgroundColor: theme.word }}>{sentence.slice(word[0], word[1])}</Text>
                {sentence.slice(word[1])}
              </>
            ) : (
              sentence
            )}
            {space}
          </Text>
        );
      })}
    </Text>
  );
});

function Tool({ theme, icon, label, onPress, active, testID }: { theme: Theme; icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; active?: boolean; testID?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} style={({ pressed }) => ({ alignItems: 'center', flex: 1, gap: 3, opacity: pressed ? 0.6 : 1, paddingVertical: 4 })}>
      <Ionicons name={icon} size={22} color={active ? theme.accent : theme.text} />
      <Text style={{ fontSize: 11, color: active ? theme.accent : theme.muted }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function TranslateSheet({
  visible,
  book,
  theme,
  onClose,
  onStart,
}: {
  visible: boolean;
  book: Book;
  theme: Theme;
  onClose: () => void;
  onStart: (language: string) => void;
}) {
  const s = styles(theme);
  const [target, setTarget] = useState(book.language === 'tr' ? 'en' : 'tr');
  return (
    <Sheet visible={visible} title="Kitabı çevir" onClose={onClose} action={{ label: 'Çevir', onPress: () => onStart(target), testID: 'translate-start' }}>
      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        <Text style={s.body}>
          Kitap telefonunuzda {languageLabel(target)} diline çevrilir ve kitaplığa ayrı bir kitap olarak eklenir. Çeviri sürerken
          dinlemeye başlayabilirsiniz; sayfalar sırayla hazırlanır.
        </Text>
        <View style={s.wrapRow}>
          {TRANSLATION_TARGETS.filter((l) => l !== book.language).map((l) => (
            <Pressable key={l} onPress={() => setTarget(l)} style={[s.pill, l === target && s.pillActive]} testID={`translate-to-${l}`}>
              <Text style={[s.pillText, l === target && s.pillTextActive]}>{languageLabel(l)}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.small}>
          İlk çeviride dil paketi indirilir (bir kez, internet gerekir). Sonrasında çeviri internetsiz yapılır ve kitabınız cihazdan çıkmaz.
        </Text>
      </View>
    </Sheet>
  );
}

function SpeedSheet({ visible, rate, theme, onClose }: { visible: boolean; rate: number; theme: Theme; onClose: () => void }) {
  const s = styles(theme);
  return (
    <Sheet visible={visible} title={`Okuma hızı · ${formatRate(rate)}×`} onClose={onClose}>
      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={s.small}>0.5×</Text>
          <Slider
            style={{ flex: 1 }}
            minimumValue={0.5}
            maximumValue={3}
            step={0.05}
            value={rate}
            minimumTrackTintColor={theme.accent}
            maximumTrackTintColor={theme.border}
            thumbTintColor={theme.accent}
            onSlidingComplete={(v) => updatePrefs({ rate: Math.round(v * 100) / 100 })}
            testID="rate-slider"
          />
          <Text style={s.small}>3×</Text>
        </View>
        <View style={s.wrapRow}>
          {RATE_PRESETS.map((r) => (
            <Pressable key={r} onPress={() => updatePrefs({ rate: r })} style={[s.pill, r === rate && s.pillActive]} testID={`rate-${r}`}>
              <Text style={[s.pillText, r === rate && s.pillTextActive]}>{formatRate(r)}×</Text>
            </Pressable>
          ))}
        </View>
        {!usesAudioPipeline && rate > 2 ? <Text style={s.small}>Bu ortamda en yüksek hız 2× ile sınırlı olabilir.</Text> : null}
      </View>
    </Sheet>
  );
}

function SleepSheet({ visible, active, theme, onClose, onPick }: { visible: boolean; active: boolean; theme: Theme; onClose: () => void; onPick: (m: number) => void }) {
  const s = styles(theme);
  return (
    <Sheet visible={visible} title="Uyku zamanlayıcısı" onClose={onClose}>
      <View style={[s.wrapRow, { paddingHorizontal: 20 }]}>
        {SLEEP_MINUTES.map((m) => (
          <Pressable key={m} onPress={() => onPick(m)} style={s.pill} testID={`sleep-${m}`}>
            <Text style={s.pillText}>{m} dk</Text>
          </Pressable>
        ))}
        {active ? (
          <Pressable onPress={() => onPick(0)} style={[s.pill, { borderColor: theme.danger }]} testID="sleep-off">
            <Text style={[s.pillText, { color: theme.danger }]}>Kapat</Text>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}

const THEMES: { key: ThemeName; label: string; bg: string; fg: string }[] = [
  { key: 'auto', label: 'Otomatik', bg: '#DDDDDD', fg: '#222222' },
  { key: 'light', label: 'Açık', bg: '#FAF7F2', fg: '#1F1B16' },
  { key: 'sepia', label: 'Sepya', bg: '#F4ECD8', fg: '#3B2F22' },
  { key: 'dark', label: 'Koyu', bg: '#141210', fg: '#EDE6DC' },
];

function AppearanceSheet({ visible, theme, onClose }: { visible: boolean; theme: Theme; onClose: () => void }) {
  const prefs = usePrefs();
  const s = styles(theme);
  const fonts: { key: FontFamily; label: string }[] = [
    { key: 'serif', label: 'Tırnaklı' },
    { key: 'sans', label: 'Sade' },
  ];
  return (
    <Sheet visible={visible} title="Görünüm" onClose={onClose}>
      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        <View style={s.wrapRow}>
          {THEMES.map((th) => (
            <Pressable
              key={th.key}
              onPress={() => updatePrefs({ theme: th.key })}
              style={[s.themeSwatch, { backgroundColor: th.bg }, prefs.theme === th.key && { borderColor: theme.accent, borderWidth: 2 }]}
              testID={`theme-${th.key}`}
            >
              <Text style={{ color: th.fg, fontWeight: '600' }}>{th.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={s.wrapRow}>
          {fonts.map((f) => (
            <Pressable key={f.key} onPress={() => updatePrefs({ fontFamily: f.key })} style={[s.pill, prefs.fontFamily === f.key && s.pillActive]}>
              <Text style={[s.pillText, { fontFamily: fontFor(f.key) }, prefs.fontFamily === f.key && s.pillTextActive]}>{f.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.small}>Yazı boyutu · {prefs.fontSize}</Text>
        <Slider
          minimumValue={14}
          maximumValue={36}
          step={1}
          value={prefs.fontSize}
          minimumTrackTintColor={theme.accent}
          maximumTrackTintColor={theme.border}
          thumbTintColor={theme.accent}
          onSlidingComplete={(v) => updatePrefs({ fontSize: v })}
          testID="font-slider"
        />
        <Text style={s.small}>Satır aralığı · {prefs.lineHeight.toFixed(2)}</Text>
        <Slider
          minimumValue={1.2}
          maximumValue={2.2}
          step={0.05}
          value={prefs.lineHeight}
          minimumTrackTintColor={theme.accent}
          maximumTrackTintColor={theme.border}
          thumbTintColor={theme.accent}
          onSlidingComplete={(v) => updatePrefs({ lineHeight: Math.round(v * 100) / 100 })}
        />
        <Text style={{ fontSize: prefs.fontSize, lineHeight: prefs.fontSize * prefs.lineHeight, fontFamily: fontFor(prefs.fontFamily), color: theme.text }}>
          Örnek metin: Kitabınız böyle görünecek.
        </Text>
      </View>
    </Sheet>
  );
}

type TocTab = 'contents' | 'bookmarks' | 'search';

function TocSheet({
  visible,
  book,
  processing,
  current,
  theme,
  onClose,
  onPick,
}: {
  visible: boolean;
  book: Book;
  processing: boolean;
  current: number;
  theme: Theme;
  onClose: () => void;
  onPick: (pos: { sectionIdx: number; sentenceIdx: number }) => void;
}) {
  const db = useSQLiteContext();
  const s = styles(theme);
  const [tab, setTab] = useState<TocTab>('contents');
  const [items, setItems] = useState<{ idx: number; title: string; needs_ocr: number }[]>([]);
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchToken = useRef(0);

  useEffect(() => {
    if (!visible) return;
    void getSectionTitles(db, book.id).then(setItems);
    void listBookmarks(db, book.id).then(setMarks);
  }, [visible, db, book.id]);

  const runSearch = async () => {
    const token = ++searchToken.current;
    setSearching(true);
    const res = await searchBook(db, book.id, book.sectionCount, query, () => token !== searchToken.current);
    if (token !== searchToken.current) return;
    setHits(res);
    setSearching(false);
  };

  const tabs: { key: TocTab; label: string }[] = [
    { key: 'contents', label: 'İçindekiler' },
    { key: 'bookmarks', label: `Yer imleri${marks.length ? ` (${marks.length})` : ''}` },
    { key: 'search', label: 'Ara' },
  ];

  return (
    <Sheet visible={visible} title={book.title} onClose={onClose} tall>
      <View style={s.tabs}>
        {tabs.map((tb) => (
          <Pressable key={tb.key} onPress={() => setTab(tb.key)} style={[s.tab, tab === tb.key && s.tabActive]} testID={`tab-${tb.key}`}>
            <Text style={[s.tabText, tab === tb.key && { color: theme.accent }]}>{tb.label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'contents' ? (
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.idx)}
          initialScrollIndex={items.length ? Math.min(current, items.length - 1) : undefined}
          getItemLayout={(_, index) => ({ length: 52, offset: 52 * index, index })}
          renderItem={({ item }) => (
            <Pressable style={[s.row, item.idx === current && { backgroundColor: theme.highlight }]} onPress={() => onPick({ sectionIdx: item.idx, sentenceIdx: 0 })}>
              <Text style={s.rowText} numberOfLines={1}>
                {item.title}
                {item.needs_ocr === 1 && processing ? '  · tanınıyor' : item.needs_ocr ? '  · metinsiz' : ''}
              </Text>
            </Pressable>
          )}
        />
      ) : tab === 'bookmarks' ? (
        <FlatList
          data={marks}
          keyExtractor={(m) => String(m.id)}
          ListEmptyComponent={<Text style={s.notice}>Henüz yer imi yok. Okurken alttaki yer imi düğmesine dokunun.</Text>}
          renderItem={({ item }) => (
            <View style={s.markRow}>
              <Pressable style={{ flex: 1 }} onPress={() => onPick({ sectionIdx: item.sectionIdx, sentenceIdx: item.sentenceIdx })}>
                <Text style={s.small}>{item.sectionTitle}</Text>
                <Text style={s.rowText} numberOfLines={2}>
                  {item.excerpt}
                </Text>
              </Pressable>
              <Pressable
                hitSlop={10}
                accessibilityLabel="Yer imini sil"
                onPress={async () => {
                  await deleteBookmark(db, item.id);
                  setMarks(await listBookmarks(db, book.id));
                }}
              >
                <Ionicons name="trash-outline" size={20} color={theme.muted} />
              </Pressable>
            </View>
          )}
        />
      ) : (
        <View style={{ flex: 1 }}>
          <View style={s.searchBox}>
            <Ionicons name="search" size={18} color={theme.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={runSearch}
              placeholder="Kitapta ara…"
              placeholderTextColor={theme.muted}
              returnKeyType="search"
              style={{ flex: 1, color: theme.text, fontSize: 16, paddingVertical: 10 }}
              testID="search-input"
            />
            {searching ? <ActivityIndicator color={theme.accent} /> : null}
          </View>
          <FlatList
            data={hits ?? []}
            keyExtractor={(h, i) => `${h.sectionIdx}-${h.sentenceIdx}-${i}`}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={hits && !searching ? <Text style={s.notice}>Sonuç bulunamadı.</Text> : undefined}
            renderItem={({ item }) => (
              <Pressable style={s.markRow} onPress={() => onPick({ sectionIdx: item.sectionIdx, sentenceIdx: item.sentenceIdx })} testID="search-hit">
                <View style={{ flex: 1 }}>
                  <Text style={s.small}>{item.sectionTitle}</Text>
                  <Text style={s.rowText} numberOfLines={2}>
                    …{item.before}
                    <Text style={{ backgroundColor: theme.highlight, fontWeight: '700' }}>{item.match}</Text>
                    {item.after}…
                  </Text>
                </View>
              </Pressable>
            )}
          />
        </View>
      )}
    </Sheet>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    content: { paddingHorizontal: 22, paddingTop: 14, paddingBottom: 40, maxWidth: 760, width: '100%', alignSelf: 'center' },
    notice: { color: t.muted, fontSize: 16, lineHeight: 23, padding: 20, textAlign: 'center' },
    controls: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border, backgroundColor: t.surface, paddingTop: 8, paddingHorizontal: 14, gap: 6 },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 760, width: '100%', alignSelf: 'center' },
    track: { height: 4, borderRadius: 2, backgroundColor: t.border, overflow: 'hidden' },
    fill: { height: 4, backgroundColor: t.accent },
    where: { textAlign: 'center', color: t.muted, fontSize: 12 },
    transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36 },
    transportBtn: { padding: 6 },
    playBtn: { width: 68, height: 68, borderRadius: 34, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    toolbar: { flexDirection: 'row', maxWidth: 760, width: '100%', alignSelf: 'center' },
    small: { color: t.muted, fontSize: 13 },
    body: { color: t.text, fontSize: 15, lineHeight: 21 },
    wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    pill: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg },
    pillActive: { backgroundColor: t.accent, borderColor: t.accent },
    pillText: { color: t.text, fontWeight: '600' },
    pillTextActive: { color: t.accentText },
    themeSwatch: { width: 76, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.border },
    tabs: { flexDirection: 'row', paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    tab: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 2, borderColor: 'transparent' },
    tabActive: { borderColor: t.accent },
    tabText: { color: t.muted, fontWeight: '600' },
    row: { height: 52, justifyContent: 'center', paddingHorizontal: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    rowText: { fontSize: 16, color: t.text },
    markRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border },
  });
