import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { deleteBook, listBooks, type Book } from '@/db/database';
import { useExtractor } from '@/engine/ExtractorProvider';
import { useBooksChanged } from '@/engine/booksEvents';
import { deleteBookFile, NOT_YET_SUPPORTED, pickAndImportBooks } from '@/lib/importBooks';
import { useTheme, type Theme } from '@/ui/theme';

export default function Library() {
  const db = useSQLiteContext();
  const t = useTheme();
  const s = styles(t);
  const { enqueue } = useExtractor();
  const { width } = useWindowDimensions();
  const columns = width >= 1000 ? 3 : width >= 640 ? 2 : 1;
  const [books, setBooks] = useState<Book[] | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(() => {
    void listBooks(db).then(setBooks);
  }, [db]);

  useFocusEffect(refresh);
  useBooksChanged(refresh);

  const addBooks = useCallback(async () => {
    setImporting(true);
    try {
      const { imported, rejected } = await pickAndImportBooks(db);
      imported.forEach(enqueue);
      refresh();
      if (rejected.length) {
        Alert.alert(
          'Bazı dosyalar eklenemedi',
          `${rejected.join(', ')}\n\nŞu an desteklenen biçimler: PDF, EPUB, TXT, FB2, HTML.\n${NOT_YET_SUPPORTED.slice(0, 4).join(', ').toUpperCase()} desteği sonraki sürümde gelecek.`,
        );
      }
    } catch (e) {
      Alert.alert('Dosya eklenemedi', (e as Error).message);
    } finally {
      setImporting(false);
    }
  }, [db, enqueue, refresh]);

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
    Alert.alert('Kitabı sil', `"${b.title}" kitaplığınızdan ve cihazdan silinsin mi?`, [
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

  return (
    <View style={s.root}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={addBooks} disabled={importing} hitSlop={12} accessibilityRole="button" accessibilityLabel="Kitap ekle">
              {importing ? <ActivityIndicator color={t.accent} /> : <Text style={s.addText}>+ Ekle</Text>}
            </Pressable>
          ),
        }}
      />
      {books === null ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={t.accent} />
      ) : books.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>Kitaplığınız boş</Text>
          <Text style={s.emptyBody}>
            PDF, EPUB, TXT, FB2 veya HTML dosyası ekleyin. Kitaplar sesli okunur ve kaldığınız cümle otomatik kaydedilir.
          </Text>
          <Pressable style={s.primary} onPress={addBooks} accessibilityRole="button">
            <Text style={s.primaryText}>Kitap ekle</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          key={columns}
          data={books}
          numColumns={columns}
          keyExtractor={(b) => b.id}
          contentContainerStyle={s.list}
          columnWrapperStyle={columns > 1 ? { gap: 12 } : undefined}
          renderItem={({ item }) => (
            <BookCard book={item} theme={t} onPress={() => open(item)} onLongPress={() => confirmDelete(item)} />
          )}
        />
      )}
    </View>
  );
}

function BookCard({ book, theme, onPress, onLongPress }: { book: Book; theme: Theme; onPress: () => void; onLongPress: () => void }) {
  const s = styles(theme);
  const processing = book.status === 'processing';
  const unit = book.format === 'pdf' ? 'sayfa' : 'bölüm';
  let status: string;
  if (processing) {
    status = book.sectionCount
      ? `Hazırlanıyor… ${book.processedCount}/${book.sectionCount} ${unit}`
      : 'Hazırlanıyor…';
  } else if (book.status === 'error') {
    status = 'Hata — dokunun';
  } else {
    status = `%${Math.round(book.progress * 100)} · ${book.sectionCount} ${unit}`;
    if (book.ocrPendingCount > 0) status += ` · ${book.ocrPendingCount} ${unit} metinsiz`;
  }
  const bar = processing && book.sectionCount ? book.processedCount / book.sectionCount : book.progress;
  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityHint="Açmak için dokunun, silmek için basılı tutun"
    >
      <View style={s.cardTop}>
        <Text style={s.badge}>{book.format.toUpperCase()}</Text>
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
      <Text style={[s.status, book.status === 'error' && { color: theme.danger }]}>{status}</Text>
    </Pressable>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    addText: { color: t.accent, fontSize: 17, fontWeight: '600' },
    list: { padding: 16, gap: 12 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
    emptyTitle: { fontSize: 22, fontWeight: '700', color: t.text },
    emptyBody: { fontSize: 16, color: t.muted, textAlign: 'center', lineHeight: 23, maxWidth: 420 },
    primary: { backgroundColor: t.accent, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, marginTop: 8 },
    primaryText: { color: t.accentText, fontSize: 17, fontWeight: '600' },
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
