import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useExtractor } from '@/engine/ExtractorProvider';
import { createAudioBook } from '@/lib/audioBooks';
import { audioBookInfo, DEFAULT_BASES, searchCatalog, SOURCE_LABEL, type CatalogBases, type CatalogItem, type CatalogKind } from '@/lib/catalog';
import { importFromUrl } from '@/lib/importBooks';
import { languageLabel } from '@/lib/voices';
import { useTheme, type Theme } from '@/ui/theme';

// E2E builds search a stand-in catalog on the test server instead of the real sites.
function catalogBases(): CatalogBases {
  if (!Constants.expoConfig?.extra?.catalogMock) return DEFAULT_BASES;
  const host = Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://127.0.0.1:8000';
  return { archive: `${host}/mock-archive`, gutendex: `${host}/mock-gutendex` };
}

export default function DiscoverScreen() {
  const db = useSQLiteContext();
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const { enqueue } = useExtractor();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<CatalogKind>('audio');
  const [turkish, setTurkish] = useState(false);
  const [results, setResults] = useState<CatalogItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const search = async (k = kind, tr = turkish) => {
    if (query.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await searchCatalog(query, { kind: k, turkishOnly: tr }, fetch, catalogBases()));
    } catch (e) {
      setResults(null);
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const add = async (item: CatalogItem) => {
    const key = `${item.source}:${item.id}`;
    setAdding(key);
    try {
      if (item.kind === 'audio') {
        const info = await audioBookInfo(item, fetch, catalogBases());
        const id = await createAudioBook(db, { ...info, title: info.title || item.title, author: info.author ?? item.author });
        enqueue(id);
        router.replace({ pathname: '/audio/[id]', params: { id } });
      } else {
        const id = await importFromUrl(db, item.url!);
        enqueue(id);
        Alert.alert('E-kitap eklendi', `“${item.title}” kitaplığınıza eklendi; hazırlanınca seçtiğiniz sesle okunur.`, [{ text: 'Kitaplığa dön', onPress: () => router.back() }]);
      }
    } catch (e) {
      Alert.alert('İndirilemedi', (e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  const pickKind = (k: CatalogKind) => {
    setKind(k);
    setResults(null);
    if (query.trim().length >= 2) void search(k, turkish);
  };

  const toggleTurkish = () => {
    setTurkish(!turkish);
    if (query.trim().length >= 2) void search(kind, !turkish);
  };

  return (
    <View style={s.root}>
      <View style={s.top}>
        <View style={s.searchBox}>
          <Ionicons name="search" size={18} color={t.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Kitap ya da yazar adı"
            placeholderTextColor={t.muted}
            style={s.input}
            returnKeyType="search"
            autoCorrect={false}
            onSubmitEditing={() => void search()}
            testID="discover-input"
          />
          <Pressable onPress={() => void search()} hitSlop={8} testID="discover-submit" accessibilityLabel="Ara">
            {searching ? <ActivityIndicator color={t.accent} /> : <Ionicons name="arrow-forward-circle" size={28} color={t.accent} />}
          </Pressable>
        </View>
        <View style={s.pills}>
          <Pill theme={t} label="Sesli kitap" active={kind === 'audio'} onPress={() => pickKind('audio')} testID="discover-audio" />
          <Pill theme={t} label="E-kitap" active={kind === 'ebook'} onPress={() => pickKind('ebook')} testID="discover-ebook" />
          <Pill theme={t} label="Yalnız Türkçe" active={turkish} onPress={toggleTurkish} testID="discover-turkish" />
        </View>
        <Text style={s.hint}>
          {kind === 'audio'
            ? 'Gönüllülerin seslendirdiği kamu malı kitaplar (LibriVox) ve açık lisanslı sesli kitaplar (Internet Archive). İndirilenler internetsiz dinlenir.'
            : 'Project Gutenberg’in telifsiz e-kitapları; uygulamanın sesiyle okunur. Türkçe kitap sayısı azdır.'}
        </Text>
      </View>
      {error ? (
        <Text style={[s.hint, { color: t.danger, paddingHorizontal: 16 }]} testID="discover-error">
          {error}
        </Text>
      ) : null}
      <FlatList
        data={results ?? []}
        keyExtractor={(it) => `${it.source}:${it.id}`}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={results && !searching ? <Text style={s.hint}>Sonuç bulunamadı. Başka bir kelime deneyin{turkish ? ' ya da “Yalnız Türkçe”yi kapatın' : ''}.</Text> : undefined}
        renderItem={({ item }) => {
          const key = `${item.source}:${item.id}`;
          return (
            <View style={s.card} testID="discover-result">
              <Text style={s.source}>
                {SOURCE_LABEL[item.source].toUpperCase()}
                {item.language ? ` · ${languageLabel(item.language)}` : ''}
              </Text>
              <Text style={s.title} numberOfLines={2}>
                {item.title}
              </Text>
              {item.author ? <Text style={s.author}>{item.author}</Text> : null}
              {item.detail ? <Text style={s.detail}>{item.detail}</Text> : null}
              <Pressable onPress={() => void add(item)} disabled={adding !== null} style={[s.button, adding !== null && { opacity: 0.6 }]} testID="discover-add">
                {adding === key ? (
                  <ActivityIndicator color={t.accentText} />
                ) : (
                  <Text style={s.buttonText}>{item.kind === 'audio' ? 'İndir ve dinle' : 'Kitaplığa ekle'}</Text>
                )}
              </Pressable>
            </View>
          );
        }}
      />
    </View>
  );
}

function Pill({ theme, label, active, onPress, testID }: { theme: Theme; label: string; active: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: active ? theme.accent : theme.border, backgroundColor: active ? theme.accent : theme.surface }}
    >
      <Text style={{ color: active ? theme.accentText : theme.text, fontSize: 14, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    top: { padding: 16, paddingBottom: 4, gap: 10 },
    searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    input: { flex: 1, color: t.text, fontSize: 16, paddingVertical: 12 },
    pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    hint: { fontSize: 13, color: t.muted, lineHeight: 18 },
    card: { backgroundColor: t.surface, borderRadius: 14, padding: 14, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    source: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: t.accent },
    title: { fontSize: 17, fontWeight: '600', color: t.text },
    author: { fontSize: 14, color: t.muted },
    detail: { fontSize: 12, color: t.muted },
    button: { marginTop: 8, alignSelf: 'flex-start', backgroundColor: t.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, minWidth: 140, alignItems: 'center' },
    buttonText: { color: t.accentText, fontSize: 15, fontWeight: '600' },
  });
