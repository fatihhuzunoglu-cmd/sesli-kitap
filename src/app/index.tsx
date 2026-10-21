import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import Ionicons from '@expo/vector-icons/Ionicons';
import { deleteBook, getBook, listBooks, type Book } from '@/db/database';
import { useExtractor } from '@/engine/ExtractorProvider';
import { getOcrProgress, useBooksChanged } from '@/engine/booksEvents';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import {
  addPhotosToBook,
  createTranslation,
  deleteBookFile,
  importFromUrl,
  importPhotos,
  importText,
  NOT_YET_SUPPORTED,
  pickAndImportBooks,
  SUPPORTED_LABEL,
  writePackageFile,
} from '@/lib/importBooks';
import { PACKAGE_MIME } from '@/lib/bookPackage';
import { isPaged } from '@/lib/books';
import { Sheet } from '@/ui/Sheet';
import { Translator } from '../../modules/translator';
import { useTheme, type Theme } from '@/ui/theme';

type AddMode = null | 'menu' | 'url' | 'text';
type PhotoSource = 'camera' | 'gallery';

const canTranslate = Translator?.isSupported() ?? false;

// Lets the user pick page photos from the gallery, or shoot pages one after another until they tap "Bitti".
async function pickPhotos(source: PhotoSource): Promise<string[]> {
  if (source === 'gallery') {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, orderedSelection: true, quality: 0.9 });
    return res.canceled ? [] : res.assets.map((a) => a.uri);
  }
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    Alert.alert('Kamera izni gerekli', 'Sayfaları fotoğraflamak için Ayarlar’dan kamera izni verin.');
    return [];
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
  return shots;
}

function askPhotoSource(title: string): Promise<PhotoSource | null> {
  return new Promise((resolve) =>
    Alert.alert(title, 'Sayfaları nereden ekleyelim?', [
      { text: 'Vazgeç', style: 'cancel', onPress: () => resolve(null) },
      { text: 'Galeri', onPress: () => resolve('gallery') },
      { text: 'Kamera', onPress: () => resolve('camera') },
    ]),
  );
}

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
  const [actionsFor, setActionsFor] = useState<Book | null>(null);

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

  const addFromPhotos = (source: PhotoSource) => {
    setMode(null);
    setTimeout(async () => {
      const uris = await pickPhotos(source);
      if (uris.length) void run(async () => [await importPhotos(db, uris, photoTitle())]);
    }, 450);
  };

  // Foreign-language pages: the photos become one book, which is recognised and translated into Turkish page by page.
  const translatePhotos = () => {
    setMode(null);
    setTimeout(async () => {
      const source = await askPhotoSource('Fotoğrafları Türkçeye çevir');
      if (!source) return;
      const uris = await pickPhotos(source);
      if (!uris.length) return;
      let translationId = '';
      await run(async () => {
        const bookId = await importPhotos(db, uris, `Çevrilecek sayfalar ${new Date().toLocaleDateString('tr-TR')}`);
        translationId = await createTranslation(db, (await getBook(db, bookId))!, 'tr');
        return [bookId, translationId];
      });
      if (translationId) router.push({ pathname: '/reader/[id]', params: { id: translationId } });
    }, 450);
  };

  const translate = async (b: Book) => {
    setActionsFor(null);
    const id = await createTranslation(db, b, 'tr');
    enqueue(id);
    router.push({ pathname: '/reader/[id]', params: { id } });
  };

  const addPages = (b: Book) => {
    setActionsFor(null);
    setTimeout(async () => {
      const source = await askPhotoSource('Sayfa ekle');
      if (!source) return;
      const uris = await pickPhotos(source);
      if (uris.length) void run(() => addPhotosToBook(db, b, uris));
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

  const share = async (b: Book) => {
    setActionsFor(null);
    try {
      const file = await writePackageFile(db, b);
      await Sharing.shareAsync(file.uri, { mimeType: PACKAGE_MIME, dialogTitle: b.title, UTI: 'public.json' });
    } catch (e) {
      Alert.alert('Paylaşılamadı', (e as Error).message);
    }
  };

  // From the add menu: the sheet must be gone before the next screen opens (iOS).
  const goTo = (pathname: '/discover' | '/pc') => {
    setMode(null);
    setTimeout(() => router.push(pathname), 350);
  };

  const open = (b: Book) => {
    // An audiobook plays from the internet any chapter it could not download, so it opens even after a download error.
    if (b.format === 'audio') {
      router.push({ pathname: '/audio/[id]', params: { id: b.id } });
      return;
    }
    if (b.status === 'error') {
      Alert.alert('Kitap işlenemedi', b.error ?? '', [
        { text: 'Vazgeç', style: 'cancel' },
        { text: 'Yeniden dene', onPress: () => enqueue(b.id) },
      ]);
      return;
    }
    // A new translation has no pages yet, but its reader waits for them and starts as soon as one is ready.
    if (b.processedCount === 0 && b.format !== 'translation') return;
    router.push({ pathname: '/reader/[id]', params: { id: b.id } });
  };

  const confirmDelete = (b: Book) => {
    setActionsFor(null);
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
    () => books?.find((b) => b.lastOpenedAt && b.format !== 'audio' && b.status !== 'error' && b.processedCount > 0 && b.progress < 1) ?? null,
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
          renderItem={({ item }) => <BookCard book={item} theme={t} onPress={() => open(item)} onLongPress={() => setActionsFor(item)} />}
        />
      )}

      <Sheet visible={mode === 'menu'} title="Kitap ekle" onClose={() => setMode(null)}>
        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <MenuItem theme={t} icon="document-text-outline" title="Dosyadan" body={SUPPORTED_LABEL} onPress={addFromFiles} testID="add-file" />
          <MenuItem theme={t} icon="camera-outline" title="Sayfa fotoğrafı çek" body="Basılı kitabın sayfalarını çekin; kitap haline gelir, metin otomatik tanınır" onPress={() => addFromPhotos('camera')} testID="add-camera" />
          <MenuItem theme={t} icon="images-outline" title="Galeriden fotoğraf seç" body="Çektiğiniz sayfa fotoğraflarını tek kitapta birleştirin" onPress={() => addFromPhotos('gallery')} testID="add-gallery" />
          {canTranslate ? (
            <MenuItem theme={t} icon="language-outline" title="Fotoğrafları Türkçeye çevir" body="Yabancı dildeki sayfaları çekin; kitap yapılıp Türkçeye çevrilir" onPress={translatePhotos} testID="add-translate-photos" />
          ) : null}
          <MenuItem theme={t} icon="globe-outline" title="İnternetten sesli kitap bul" body="Ücretsiz sesli kitapları ve e-kitapları arayıp indirin" onPress={() => goTo('/discover')} testID="add-discover" />
          <MenuItem theme={t} icon="qr-code-outline" title="Bilgisayardan al" body="Karekodu okutun; bilgisayarda hazırlanan kitapları alın, telefondakileri gönderin" onPress={() => goTo('/pc')} testID="add-pc" />
          <MenuItem theme={t} icon="link-outline" title="Bağlantıdan" body="İnternetteki bir kitap dosyasını indirin" onPress={() => setMode('url')} testID="add-url" />
          <MenuItem theme={t} icon="clipboard-outline" title="Metin yapıştır" body="Bir yazıyı, makaleyi ya da notu dinleyin" onPress={() => setMode('text')} testID="add-text" />
        </View>
      </Sheet>

      <Sheet visible={actionsFor !== null} title={actionsFor?.title ?? ''} onClose={() => setActionsFor(null)}>
        {actionsFor ? (
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            {canTranslate && actionsFor.format !== 'translation' && !(actionsFor.status === 'ready' && actionsFor.language === 'tr') ? (
              <MenuItem theme={t} icon="language-outline" title="Türkçeye çevir" body="Çeviri ayrı bir kitap olur; çevrilirken dinleyebilirsiniz" onPress={() => void translate(actionsFor)} testID="action-translate" />
            ) : null}
            {actionsFor.format === 'images' ? (
              <MenuItem theme={t} icon="add-circle-outline" title="Sayfa ekle" body="Bu kitabın sonuna yeni sayfa fotoğrafları ekleyin" onPress={() => addPages(actionsFor)} testID="action-add-pages" />
            ) : null}
            {actionsFor.format !== 'audio' && actionsFor.processedCount > 0 ? (
              <MenuItem theme={t} icon="share-outline" title="Paylaş" body="Hazır kitap dosyası (.skitap) olarak başka telefona ya da bilgisayara gönderin" onPress={() => void share(actionsFor)} testID="action-share" />
            ) : null}
            <MenuItem theme={t} icon="trash-outline" title="Sil" body="Kitabı kitaplıktan ve cihazdan kaldırır" onPress={() => confirmDelete(actionsFor)} testID="action-delete" />
          </View>
        ) : null}
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

const FORMAT_LABEL: Partial<Record<Book['format'], string>> = { images: 'FOTOĞRAF', mobi: 'KINDLE', docx: 'WORD', translation: 'ÇEVİRİ', skitap: 'HAZIR KİTAP', audio: 'SESLİ KİTAP' };

function BookCard({ book, theme, onPress, onLongPress }: { book: Book; theme: Theme; onPress: () => void; onLongPress: () => void }) {
  const s = styles(theme);
  const processing = book.status === 'processing';
  const unit = isPaged(book) ? 'sayfa' : 'bölüm';
  const ocr = getOcrProgress(book.id);
  let status: string;
  if (book.format === 'audio') {
    const missing = book.ocrPendingCount;
    status = processing
      ? `İndiriliyor… ${book.sectionCount - missing}/${book.sectionCount} bölüm`
      : `%${Math.round(book.progress * 100)} · ${book.sectionCount} bölüm${missing ? ` · ${missing} bölüm internetten` : ''}`;
  } else if (processing) {
    status = ocr
      ? `Metin tanınıyor… ${ocr.done}/${ocr.total} ${unit}`
      : book.format === 'translation'
        ? `Çevriliyor… ${book.processedCount}/${book.sectionCount} ${unit}`
        : book.sectionCount
        ? `Hazırlanıyor… ${book.processedCount}/${book.sectionCount} ${unit}`
        : 'Hazırlanıyor…';
  } else if (book.status === 'error') {
    status = 'Hata — dokunun';
  } else {
    status = `%${Math.round(book.progress * 100)} · ${book.sectionCount} ${unit}`;
    if (book.ocrPendingCount > 0) status += ` · ${book.ocrPendingCount} ${unit} metinsiz`;
  }
  const bar = book.format === 'audio' ? (processing ? (book.sectionCount - book.ocrPendingCount) / Math.max(1, book.sectionCount) : book.progress) : ocr ? ocr.done / Math.max(1, ocr.total) : processing && book.sectionCount ? book.processedCount / book.sectionCount : book.progress;
  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityHint="Açmak için dokunun; çevirmek, sayfa eklemek ya da silmek için basılı tutun"
      testID="book-card"
    >
      <View style={s.cardTop}>
        <Text style={s.badge}>{FORMAT_LABEL[book.format] ?? book.format.toUpperCase()}</Text>
        {processing && book.processedCount > 0 && <Text style={s.readable}>{book.format === 'audio' ? 'Dinlenebilir' : 'Okunabilir'}</Text>}
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
