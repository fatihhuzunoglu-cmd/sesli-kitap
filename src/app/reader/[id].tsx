import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import { getBook, getPosition, getSectionTitles, getSetting, setSetting, updateBook, type Book } from '@/db/database';
import { useBooksChanged } from '@/engine/booksEvents';
import { useNarrator } from '@/tts/useNarrator';
import type { Paragraph } from '@/lib/text';
import { useTheme, type Theme } from '@/ui/theme';

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_MINUTES = [0, 15, 30, 45, 60];
const LANGUAGES: { code: string; label: string }[] = [
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
];

export default function ReaderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const [book, setBook] = useState<Book | null>(null);
  const [prefs, setPrefs] = useState<{ rate: number; fontSize: number; voices: Record<string, string> } | null>(null);

  const reloadBook = useCallback(() => {
    void getBook(db, id).then(setBook);
  }, [db, id]);

  useEffect(() => {
    reloadBook();
    void updateBook(db, id, { last_opened_at: Date.now() });
    void Promise.all([
      getSetting(db, 'tts.rate', 1),
      getSetting(db, 'reader.fontSize', 19),
      getSetting<Record<string, string>>(db, 'tts.voices', {}),
    ]).then(([rate, fontSize, voices]) => setPrefs({ rate, fontSize, voices }));
  }, [db, id, reloadBook]);

  useBooksChanged(useCallback(() => {
    if (book?.status === 'processing') reloadBook();
  }, [book?.status, reloadBook]));

  if (!book || !prefs) return <ActivityIndicator style={{ marginTop: 48 }} />;
  return <Reader book={book} prefs={prefs} setPrefs={setPrefs} onBookChanged={reloadBook} />;
}

type Prefs = { rate: number; fontSize: number; voices: Record<string, string> };

function Reader({ book, prefs, setPrefs, onBookChanged }: { book: Book; prefs: Prefs; setPrefs: (p: Prefs) => void; onBookChanged: () => void }) {
  const db = useSQLiteContext();
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<Paragraph>>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [sleepMinutes, setSleepMinutes] = useState(0);

  const voice = prefs.voices[book.language] ?? null;
  const { narrator, section, position, playing, sleepAt } = useNarrator(db, book.id, book.sectionCount, {
    language: book.language,
    rate: prefs.rate,
    voice,
  });

  useEffect(() => {
    void getPosition(db, book.id).then(async (pos) => {
      await narrator.initialise(pos ?? { sectionIdx: 0, sentenceIdx: 0 });
      setReady(true);
    });
  }, [db, book.id, narrator]);

  const savePrefs = (next: Prefs) => {
    setPrefs(next);
    void setSetting(db, 'tts.rate', next.rate);
    void setSetting(db, 'reader.fontSize', next.fontSize);
    void setSetting(db, 'tts.voices', next.voices);
  };

  const currentParagraph = useMemo(() => {
    if (!section) return -1;
    const ps = section.paragraphs;
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].firstSentence <= position.sentenceIdx) return i;
    return 0;
  }, [section, position.sentenceIdx]);

  const scrolledFor = useRef<string>('');
  useEffect(() => {
    if (!ready || !section || currentParagraph < 0) return;
    const key = `${section.idx}:${currentParagraph}`;
    if (scrolledFor.current === key) return;
    const first = scrolledFor.current === '' || !scrolledFor.current.startsWith(`${section.idx}:`);
    scrolledFor.current = key;
    if (!playing && !first) return;
    requestAnimationFrame(() =>
      listRef.current?.scrollToIndex({ index: currentParagraph, viewPosition: 0.25, animated: !first }),
    );
  }, [ready, section, currentParagraph, playing]);

  const activeSleep = sleepAt === null ? 0 : sleepMinutes;
  const cycleSleep = () => {
    const next = SLEEP_MINUTES[(SLEEP_MINUTES.indexOf(activeSleep) + 1) % SLEEP_MINUTES.length];
    setSleepMinutes(next);
    narrator.setSleepAt(next ? Date.now() + next * 60_000 : null);
  };

  const nextRate = () => {
    const i = RATES.indexOf(prefs.rate);
    savePrefs({ ...prefs, rate: RATES[(i + 1) % RATES.length] });
  };

  const unit = book.format === 'pdf' ? 'Sayfa' : 'Bölüm';
  const stillProcessing = book.status === 'processing' && position.sectionIdx >= book.processedCount - 1;

  return (
    <View style={s.root}>
      <Stack.Screen
        options={{
          title: section?.title ?? book.title,
          headerRight: () => (
            <Pressable onPress={() => setTocOpen(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel="İçindekiler">
              <Text style={s.headerBtn}>İçindekiler</Text>
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
          initialNumToRender={20}
          windowSize={11}
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.25, animated: false }), 100);
          }}
          ListEmptyComponent={
            <Text style={s.notice}>
              {section === null
                ? 'Bu bölüm hâlâ hazırlanıyor…'
                : section.needsOcr
                  ? 'Bu sayfada seçilebilir metin yok (taranmış sayfa veya resim). Resimden okuma (OCR) bir sonraki sürümde eklenecek; sesli okuma bu sayfayı atlar.'
                  : 'Bu bölüm boş.'}
            </Text>
          }
          renderItem={({ item, index }) => (
            <ParagraphView
              paragraph={item}
              activeSentence={index === currentParagraph ? position.sentenceIdx : -1}
              fontSize={prefs.fontSize}
              theme={t}
              onPressSentence={narrator.playSentence}
            />
          )}
        />
      )}

      <View style={[s.controls, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.row}>
          <Pressable style={s.navBtn} onPress={() => narrator.goToSection(position.sectionIdx - 1)} disabled={position.sectionIdx === 0} accessibilityLabel={`Önceki ${unit.toLowerCase()}`}>
            <Text style={[s.navText, position.sectionIdx === 0 && s.disabled]}>‹ Önceki</Text>
          </Pressable>
          <Pressable
            style={s.playBtn}
            onPress={playing ? narrator.pause : narrator.play}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Duraklat' : 'Sesli oku'}
          >
            <Text style={s.playText}>{playing ? '❚❚' : '▶'}</Text>
          </Pressable>
          <Pressable
            style={s.navBtn}
            onPress={() => narrator.goToSection(position.sectionIdx + 1)}
            disabled={position.sectionIdx >= book.sectionCount - 1 || stillProcessing}
            accessibilityLabel={`Sonraki ${unit.toLowerCase()}`}
          >
            <Text style={[s.navText, (position.sectionIdx >= book.sectionCount - 1 || stillProcessing) && s.disabled]}>Sonraki ›</Text>
          </Pressable>
        </View>
        <Text style={s.where}>
          {unit} {position.sectionIdx + 1} / {book.sectionCount}
        </Text>
        <View style={s.row}>
          <Chip label={`${prefs.rate}×`} onPress={nextRate} theme={t} hint="Okuma hızı" />
          <Chip label={LANGUAGES.find((l) => l.code === book.language)?.label ?? book.language} onPress={() => setVoiceOpen(true)} theme={t} hint="Dil ve ses" />
          <Chip label={activeSleep ? `⏾ ${activeSleep} dk` : '⏾ Kapalı'} onPress={cycleSleep} theme={t} hint="Uyku zamanlayıcısı" />
          <Chip label="A−" onPress={() => savePrefs({ ...prefs, fontSize: Math.max(14, prefs.fontSize - 2) })} theme={t} hint="Yazıyı küçült" />
          <Chip label="A+" onPress={() => savePrefs({ ...prefs, fontSize: Math.min(34, prefs.fontSize + 2) })} theme={t} hint="Yazıyı büyüt" />
        </View>
      </View>

      <TocModal
        visible={tocOpen}
        bookId={book.id}
        current={position.sectionIdx}
        theme={t}
        onClose={() => setTocOpen(false)}
        onPick={(idx) => {
          setTocOpen(false);
          void narrator.goToSection(idx);
        }}
      />
      <VoiceModal
        visible={voiceOpen}
        language={book.language}
        voice={voice}
        theme={t}
        onClose={() => setVoiceOpen(false)}
        onLanguage={async (code) => {
          await updateBook(db, book.id, { language: code });
          onBookChanged();
        }}
        onVoice={(v) => savePrefs({ ...prefs, voices: { ...prefs.voices, [book.language]: v } })}
      />
    </View>
  );
}

const ParagraphView = memo(function ParagraphView({
  paragraph,
  activeSentence,
  fontSize,
  theme,
  onPressSentence,
}: {
  paragraph: Paragraph;
  activeSentence: number;
  fontSize: number;
  theme: Theme;
  onPressSentence: (i: number) => void;
}) {
  return (
    <Text style={{ fontSize, lineHeight: fontSize * 1.55, color: theme.text, marginBottom: fontSize * 0.8 }}>
      {paragraph.sentences.map((sentence, j) => {
        const idx = paragraph.firstSentence + j;
        return (
          <Text
            key={j}
            onPress={() => onPressSentence(idx)}
            style={idx === activeSentence ? { backgroundColor: theme.highlight } : undefined}
          >
            {sentence}
            {j < paragraph.sentences.length - 1 ? ' ' : ''}
          </Text>
        );
      })}
    </Text>
  );
});

function Chip({ label, onPress, theme, hint }: { label: string; onPress: () => void; theme: Theme; hint: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={hint}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: theme.bg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ color: theme.text, fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

function TocModal({ visible, bookId, current, theme, onClose, onPick }: { visible: boolean; bookId: string; current: number; theme: Theme; onClose: () => void; onPick: (idx: number) => void }) {
  const db = useSQLiteContext();
  const s = styles(theme);
  const [items, setItems] = useState<{ idx: number; title: string; needs_ocr: number }[]>([]);
  useEffect(() => {
    if (visible) void getSectionTitles(db, bookId).then(setItems);
  }, [visible, db, bookId]);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.modal}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>İçindekiler</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={s.headerBtn}>Kapat</Text>
          </Pressable>
        </View>
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.idx)}
          initialScrollIndex={items.length ? Math.min(current, items.length - 1) : undefined}
          getItemLayout={(_, index) => ({ length: 52, offset: 52 * index, index })}
          renderItem={({ item }) => (
            <Pressable style={[s.tocItem, item.idx === current && { backgroundColor: theme.highlight }]} onPress={() => onPick(item.idx)}>
              <Text style={s.tocText} numberOfLines={1}>
                {item.title}
                {item.needs_ocr ? '  · metinsiz' : ''}
              </Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

function VoiceModal({ visible, language, voice, theme, onClose, onLanguage, onVoice }: { visible: boolean; language: string; voice: string | null; theme: Theme; onClose: () => void; onLanguage: (code: string) => void; onVoice: (id: string) => void }) {
  const s = styles(theme);
  const [voices, setVoices] = useState<Speech.Voice[]>([]);
  useEffect(() => {
    if (visible) void Speech.getAvailableVoicesAsync().then(setVoices);
  }, [visible]);
  const matching = voices
    .filter((v) => v.language.toLowerCase().replace('_', '-').startsWith(language))
    .sort((a, b) => (a.quality === b.quality ? a.name.localeCompare(b.name) : a.quality === 'Enhanced' ? -1 : 1));
  const languages = LANGUAGES.some((l) => l.code === language) ? LANGUAGES : [...LANGUAGES, { code: language, label: language }];
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.modal}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Dil ve ses</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={s.headerBtn}>Kapat</Text>
          </Pressable>
        </View>
        <Text style={s.sectionLabel}>Kitabın dili</Text>
        <View style={[s.row, { flexWrap: 'wrap', justifyContent: 'flex-start', paddingHorizontal: 16 }]}>
          {languages.map((l) => (
            <Pressable key={l.code} onPress={() => onLanguage(l.code)} style={[s.langChip, l.code === language && { backgroundColor: theme.accent }]}>
              <Text style={{ color: l.code === language ? theme.accentText : theme.text }}>{l.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.sectionLabel}>Ses</Text>
        <FlatList
          data={matching}
          keyExtractor={(v) => v.identifier}
          ListEmptyComponent={
            <Text style={s.notice}>
              Cihazınızda bu dil için yüklü ses bulunamadı. Telefon ayarlarından “Metin okuma (TTS)” bölümüne girip ilgili dilin ses paketini indirebilirsiniz. Varsayılan ses kullanılacak.
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={[s.tocItem, item.identifier === voice && { backgroundColor: theme.highlight }]}
              onPress={() => {
                onVoice(item.identifier);
                Speech.speak(language === 'tr' ? 'Merhaba, bu sesle okuyacağım.' : 'Hello, I will read with this voice.', { voice: item.identifier, language });
              }}
            >
              <Text style={s.tocText} numberOfLines={1}>
                {item.name} {item.quality === 'Enhanced' ? '· Yüksek kalite' : ''}
              </Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    headerBtn: { color: t.accent, fontSize: 16, fontWeight: '600' },
    content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32, maxWidth: 760, width: '100%', alignSelf: 'center' },
    notice: { color: t.muted, fontSize: 16, lineHeight: 23, padding: 16, textAlign: 'center' },
    controls: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border, backgroundColor: t.surface, paddingTop: 10, paddingHorizontal: 12, gap: 8 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    navBtn: { flex: 1, alignItems: 'center', paddingVertical: 10 },
    navText: { color: t.accent, fontSize: 16, fontWeight: '600' },
    disabled: { opacity: 0.35 },
    playBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    playText: { color: t.accentText, fontSize: 24, fontWeight: '700' },
    where: { textAlign: 'center', color: t.muted, fontSize: 13 },
    modal: { flex: 1, backgroundColor: t.bg },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
    modalTitle: { fontSize: 20, fontWeight: '700', color: t.text },
    sectionLabel: { fontSize: 13, fontWeight: '600', color: t.muted, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, textTransform: 'uppercase' },
    langChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    tocItem: { height: 52, justifyContent: 'center', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    tocText: { fontSize: 16, color: t.text },
  });
