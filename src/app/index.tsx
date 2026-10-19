import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import Ionicons from '@expo/vector-icons/Ionicons';
import { deleteBook, listBooks, type Book } from '@/db/database';
import { useExtractor } from '@/engine/ExtractorProvider';
import { getOcrProgress, useBooksChanged } from '@/engine/booksEvents';
import * as ImagePicker from 'expo-image-picker';
import { deleteBookFile, importFromUrl, importPhotos, importText, NOT_YET_SUPPORTED, pickAndImportBooks, SUPPORTED_LABEL } from '@/lib/importBooks';
import { Sheet } from '@/ui/Sheet';
import { useTheme, type Theme } from '@/ui/theme';

type AddMode = null | 'menu' | 'url' | 'text';

export default function Library() {
  const db = useSQLiteContext();
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const { enqueue } = useExtractor();
  const { width } = useWindowDimensions();
  const columns = width >= 1000 ? 3 : width >= 640 ? 2 : 1;
  const [books, setBooks] = useState<Book[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AddMode>(null);
  const [filter, setFilter] = useState('');
  const [url, setUrl] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');

  const refresh = useCallback(() => {
    void listBooks(db).then(setBooks);
  }, [db]);

  useFocusEffect(refresh);
  useBooksChanged(refresh);

  const run = async (job: () => Promise<string[]>) => {
    setBusy(true);
    try {
      const ids = await job();
      ids.forEach(enqueue);
      refresh();
      setMode(null);
    } catch (e) {
      Alert.alert('Kitap eklenemedi', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // iOS cannot present the document picker while the sheet's modal is still on screen.
  const addFromFiles = () => {
    setMode(null);
    setTimeout(() => void pickFiles(), 450);
  };

  const pickFiles = () =>
    run(async () => {
      const { imported, rejected } = await pickAndImportBooks(db);
      if (rejected.length) {
        Alert.alert(
          'Bazı dosyalar eklenemedi',
          `${rejected.join(', ')}\n\nDesteklenen biçimler: ${SUPPORTED_LABEL}.\n${NOT_YET_SUPPORTED.slice(0, 5).join(', ').toUpperCase()} desteği yakında.`,
        );
      }
      return imported;
    });

  const photoTitle = () => `Fotoğraflanan sayfalar ${new Date().toLocaleDateString('tr-TR')}`;

  const addFromGallery = () => {
    setMode(null);
    setTimeout(async () => {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, orderedSelection: true, quality: 0.9 });
      if (res.canceled || !res.assets.length) return;
      void run(async () => [await importPhotos(db, res.assets.map((a) => a.uri), photoTitle())]);
    }, 450);
  };

  // Each shot is one page; the user keeps shooting until they tap "Bitti".
  const addFromCamera = () => {
    setMode(null);
    setTimeout(async () => {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Kamera izni gerekli', 'Sayfaları fotoğraflamak için Ayarlar’dan kamera izni verin.');
        return;
      }
      const shots: string[] = [];
      for (;;) {
        const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
        if (res.canceled) break;
        shots.push(res.assets[0].uri);
        const more = await new Promise<boolean>((resolve) =>
          Alert.alert(`${shots.length}. sayfa eklendi`, 'Bir sayfa daha fotoğraflamak ister misiniz?', [
            { text: 'Bitti', onPress: () => resolve(false) },
            { text: 'Sonraki sayfa', onPress: () => resolve(true) },
          ]),
        );
        if (!more) break;
      }
      if (shots.length) void run(async () => [await importPhotos(db, shots, photoTitle())]);
    }, 450);
  };

  const addFromUrl = () =>
    run(async () => {
      const id = await importFromUrl(db, url);
      setUrl('');
      return [id];
    });

  const addFromText = () =>
    run(async () => {
      if (pasteText.trim().length < 2) throw new Error('Lütfen okunacak metni yapıştırın.');
      const id = await importText(db, pasteTitle, pasteText);
      setPasteText('');
      setPasteTitle('');
      return [id];
    });

  const open = (b: Book) => {
    if (b.status === 'error') {
      Alert.alert('Kitap işlenemedi', b.error ?? '', [
        { text: 'Vazgeç', style: 'cancel' },
        { text: 'Yeniden dene', onPress: () => enqueue(b.id) },
      ]);
      return;
    }
    if (b.processedCount === 0) return;
    router.push({ pathname: '/reader/[id]', params: { id: b.id } });
  };

  const confirmDelete = (b: Book) => {
    Alert.alert('Kitabı sil', `“${b.title}” kitaplığınızdan ve cihazdan silinsin mi?`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          await deleteBook(db, b.id);
          deleteBookFile(b.fileUri);
          refresh();
        },
      },
    ]);
  };

  const recent = useMemo(
    () => books?.find((b) => b.lastOpenedAt && b.status !== 'error' && b.processedCount > 0 && b.progress < 1) ?? null,
    [books],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase('tr');
    if (!books || !q) return books;
    return books.filter((b) => `${b.title} ${b.author ?? ''}`.toLocaleLowerCase('tr').includes(q));
  }, [books, filter]);

  return (
    <View style={s.root}>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable onPress={() => router.push('/settings')} hitSlop={12} accessibilityLabel="Ayarlar" testID="settings-button" style={{ marginRight: 16 }}>
              <Ionicons name="settings-outline" size={24} color={t.text} />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable onPress={() => setMode('menu')} disabled={busy} hitSlop={12} accessibilityRole="button" accessibilityLabel="Kitap ekle" testID="add-button">
              {busy ? <ActivityIndicator color={t.accent} /> : <Ionicons name="add" size={30} color={t.accent} />}
            </Pressable>
          ),
        }}
      />
      {books === null ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={t.accent} />
      ) : books.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="headset-outline" size={56} color={t.accent} />
          <Text style={s.emptyTitle}>Kitaplığınız boş</Text>
          <Text style={s.emptyBody}>
            {SUPPORTED_LABEL} dosyası, bir bağlantı ya da yapıştırdığınız bir metni ekleyin. Kitaplar seçtiğiniz sesle okunur ve kaldığınız cümle kaydedilir.
          </Text>
          <Pressable style={s.primary} onPress={() => setMode('menu')} accessibilityRole="button" testID="empty-add">
            <Text style={s.primaryText}>Kitap ekle</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          key={columns}
          data={visible ?? []}
          numColumns={columns}
          keyExtractor={(b) => b.id}
          contentContainerStyle={s.list}
          columnWrapperStyle={columns > 1 ? { gap: 12 } : undefined}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={{ gap: 12 }}>
              {recent && !filter ? <ContinueCard book={recent} theme={t} onPress={() => router.push({ pathname: '/reader/[id]', params: { id: recent.id, autoplay: '1' } })} /> : null}
              {books.length > 3 ? (
                <View style={s.filter}>
                  <Ionicons name="search" size={18} color={t.muted} />
                  <TextInput value={filter} onChangeText={setFilter} placeholder="Kitaplıkta ara" placeholderTextColor={t.muted} style={s.filterInput} />
                </View>
              ) : null}
            </View>
          }
          renderItem={({ item }) => <BookCard book={item} theme={t} onPress={() => open(item)} onLongPress={() => confirmDelete(item)} />}
        />
      )}

      <Sheet visible={mode === 'menu'} title="Kitap ekle" onClose={() => setMode(null)}>
        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <MenuItem theme={t} icon="document-text-outline" title="Dosyadan" body={SUPPORTED_LABEL} onPress={addFromFiles} testID="add-file" />
          <MenuItem theme={t} icon="camera-outline" title="Sayfa fotoğrafı çek" body="Basılı kitabın sayfalarını çekin, metin otomatik tanınır" onPress={addFromCamera} testID="add-camera" />
          <MenuItem theme={t} icon="images-outline" title="Galeriden fotoğraf seç" body="Daha önce çektiğiniz sayfa fotoğraflarını okuyun" onPress={addFromGallery} testID="add-gallery" />
          <MenuItem theme={t} icon="link-outline" title="Bağlantıdan" body="İnternetteki bir kitap dosyasını indirin" onPress={() => setMode('url')} testID="add-url" />
          <MenuItem theme={t} icon="clipboard-outline" title="Metin yapıştır" body="Bir yazıyı, makaleyi ya da notu dinleyin" onPress={() => setMode('text')} testID="add-text" />
        </View>
      </Sheet>

      <Sheet visible={mode === 'url'} title="Bağlantıdan ekle" onClose={() => setMode(null)} action={{ label: 'İndir', onPress: addFromUrl, disabled: busy }}>
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://…/kitap.pdf"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={s.input}
            onSubmitEditing={addFromUrl}
            testID="url-input"
          />
          <Pressable style={s.primary} onPress={addFromUrl} disabled={busy} testID="url-submit">
            {busy ? <ActivityIndicator color={t.accentText} /> : <Text style={s.primaryText}>İndir ve ekle</Text>}
          </Pressable>
        </View>
      </Sheet>

      <Sheet visible={mode === 'text'} title="Metin yapıştır" onClose={() => setMode(null)} action={{ label: 'Ekle', onPress: addFromText, disabled: busy, testID: 'paste-submit' }}>
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          <TextInput value={pasteTitle} onChangeText={setPasteTitle} placeholder="Başlık (isteğe bağlı)" placeholderTextColor={t.muted} style={s.input} testID="paste-title" />
          <TextInput
            value={pasteText}
            onChangeText={setPasteText}
            placeholder="Okunacak metni buraya yapıştırın…"
            placeholderTextColor={t.muted}
            multiline
            textAlignVertical="top"
            style={[s.input, { height: 220 }]}
            testID="paste-text"
          />
        </View>
      </Sheet>
    </View>
  );
}

function ContinueCard({ book, theme, onPress }: { book: Book; theme: Theme; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      testID="continue-card"
      accessibilityRole="button"
      accessibilityLabel={`${book.title} kaldığınız yerden dinlemeye devam et`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 16,
        borderRadius: 16,
        backgroundColor: theme.accent,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: theme.accentText, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="play" size={26} color={theme.accent} style={{ marginLeft: 3 }} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.accentText, fontSize: 13, opacity: 0.85 }}>Kaldığın yerden dinle</Text>
        <Text style={{ color: theme.accentText, fontSize: 18, fontWeight: '700' }} numberOfLines={1}>
          {book.title}
        </Text>
        <Text style={{ color: theme.accentText, fontSize: 13, opacity: 0.85 }}>%{Math.round(book.progress * 100)} tamamlandı</Text>
      </View>
    </Pressable>
  );
}

function MenuItem({ theme, icon, title, body, onPress, testID }: { theme: Theme; icon: keyof typeof Ionicons.glyphMap; title: string; body: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14, backgroundColor: theme.bg, opacity: pressed ? 0.7 : 1 })}
    >
      <Ionicons name={icon} size={26} color={theme.accent} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: theme.muted, fontSize: 13 }}>{body}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.muted} />
    </Pressable>
  );
}

const FORMAT_LABEL: Partial<Record<Book['format'], string>> = { images: 'FOTOĞRAF', mobi: 'KINDLE', docx: 'WORD' };

function BookCard({ book, theme, onPress, onLongPress }: { book: Book; theme: Theme; onPress: () => void; onLongPress: () => void }) {
  const s = styles(theme);
  const processing = book.status === 'processing';
  const unit = book.format === 'pdf' || book.format === 'images' ? 'sayfa' : 'bölüm';
  const ocr = getOcrProgress(book.id);
  let status: string;
  if (processing) {
    status = ocr
      ? `Metin tanınıyor… ${ocr.done}/${ocr.total} ${unit}`
      : book.sectionCount
        ? `Hazırlanıyor… ${book.processedCount}/${book.sectionCount} ${unit}`
        : 'Hazırlanıyor…';
  } else if (book.status === 'error') {
    status = 'Hata — dokunun';
  } else {
    status = `%${Math.round(book.progress * 100)} · ${book.sectionCount} ${unit}`;
    if (book.ocrPendingCount > 0) status += ` · ${book.ocrPendingCount} ${unit} metinsiz`;
  }
  const bar = ocr ? ocr.done / Math.max(1, ocr.total) : processing && book.sectionCount ? book.processedCount / book.sectionCount : book.progress;
  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityHint="Açmak için dokunun, silmek için basılı tutun"
      testID="book-card"
    >
      <View style={s.cardTop}>
        <Text style={s.badge}>{FORMAT_LABEL[book.format] ?? book.format.toUpperCase()}</Text>
        {processing && book.processedCount > 0 && <Text style={s.readable}>Okunabilir</Text>}
      </View>
      <Text style={s.title} numberOfLines={2}>
        {book.title}
      </Text>
      {book.author ? (
        <Text style={s.author} numberOfLines={1}>
          {book.author}
        </Text>
      ) : null}
      <View style={s.track}>
        <View style={[s.fill, { width: `${Math.round(bar * 100)}%` }]} />
      </View>
      <Text style={[s.status, book.status === 'error' && { color: theme.danger }]} testID="book-status">
        {status}
      </Text>
    </Pressable>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    list: { padding: 16, gap: 12 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
    emptyTitle: { fontSize: 22, fontWeight: '700', color: t.text },
    emptyBody: { fontSize: 16, color: t.muted, textAlign: 'center', lineHeight: 23, maxWidth: 440 },
    primary: { backgroundColor: t.accent, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, marginTop: 8, alignItems: 'center' },
    primaryText: { color: t.accentText, fontSize: 17, fontWeight: '600' },
    input: { borderWidth: 1, borderColor: t.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: t.text, backgroundColor: t.bg, fontSize: 16 },
    filter: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, marginBottom: 4 },
    filterInput: { flex: 1, color: t.text, fontSize: 16, paddingVertical: 10 },
    card: { flex: 1, backgroundColor: t.surface, borderRadius: 14, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, gap: 6 },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    badge: { fontSize: 11, fontWeight: '700', color: t.accent, letterSpacing: 0.8 },
    readable: { fontSize: 11, color: t.muted },
    title: { fontSize: 18, fontWeight: '600', color: t.text },
    author: { fontSize: 14, color: t.muted },
    track: { height: 4, borderRadius: 2, backgroundColor: t.border, marginTop: 6, overflow: 'hidden' },
    fill: { height: 4, backgroundColor: t.accent },
    status: { fontSize: 13, color: t.muted },
  });
