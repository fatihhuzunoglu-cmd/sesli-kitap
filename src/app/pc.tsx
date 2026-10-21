import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Ionicons from '@expo/vector-icons/Ionicons';
import { getSetting, listBooks, setSetting, type Book } from '@/db/database';
import { useExtractor } from '@/engine/ExtractorProvider';
import { createAudioBook } from '@/lib/audioBooks';
import { exportPackage, importPackageFromUrl } from '@/lib/importBooks';
import { fromParams, parsePcLink, pcAudio, pcInfo, pcLibrary, pcPackageUrl, pcUpload, type PcItem, type PcLink } from '@/lib/pcLink';
import { useTheme, type Theme } from '@/ui/theme';

const SETTING = 'pcLink';

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function PcScreen() {
  const params = useLocalSearchParams<{ u?: string; t?: string; n?: string }>();
  const db = useSQLiteContext();
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const { enqueue } = useExtractor();
  const [link, setLink] = useState<PcLink | null | undefined>(undefined);
  const [pcName, setPcName] = useState<string | null>(null);
  const [items, setItems] = useState<PcItem[] | null>(null);
  const [phoneBooks, setPhoneBooks] = useState<Book[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');

  const connect = useCallback(
    async (l: PcLink) => {
      setLoading(true);
      setError(null);
      try {
        const info = await pcInfo(l);
        if (info.app !== 'seslikitap-pc') throw new Error('Bu adreste Sesli Kitap bilgisayar uygulaması yok.');
        await setSetting(db, SETTING, { ...l, name: info.name });
        setLink({ ...l, name: info.name });
        setPcName(info.name);
        setItems(await pcLibrary(l));
      } catch (e) {
        setLink(l);
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [db],
  );

  // A scanned QR code or opened link (seslikitap://pc?u=…&t=…) brings the computer's address; otherwise the saved one.
  useEffect(() => {
    const fromLink = fromParams(params);
    void (fromLink ? Promise.resolve(fromLink) : getSetting<PcLink | null>(db, SETTING, null)).then((l) => {
      if (l) void connect(l);
      else setLink(null);
    });
  }, [db, connect, params.u, params.t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void listBooks(db).then((books) => setPhoneBooks(books.filter((b) => b.format !== 'audio' && b.processedCount > 0)));
  }, [db]);

  const refresh = () => link && void connect(link);

  const forget = async () => {
    await setSetting(db, SETTING, null);
    setLink(null);
    setItems(null);
    setError(null);
    setPcName(null);
  };

  const manual = () => {
    const l = parsePcLink(address, code);
    if (!l) {
      Alert.alert('Eksik bilgi', 'Bilgisayardaki Sesli Kitap’ın gösterdiği adresi (ör. 192.168.1.20:47800) ve bağlantı kodunu yazın.');
      return;
    }
    void connect(l);
  };

  const receive = async (item: PcItem) => {
    if (!link) return;
    setBusy(item.id);
    try {
      if (item.kind === 'audio') {
        const info = await pcAudio(link, item.id);
        const id = await createAudioBook(db, info);
        enqueue(id);
        router.push({ pathname: '/audio/[id]', params: { id } });
      } else {
        const id = await importPackageFromUrl(db, pcPackageUrl(link, item.id));
        Alert.alert('Kitaplığa eklendi', `“${item.title}” telefona alındı; hemen okunabilir.`, [
          { text: 'Tamam', style: 'cancel' },
          { text: 'Aç', onPress: () => router.push({ pathname: '/reader/[id]', params: { id } }) },
        ]);
      }
    } catch (e) {
      Alert.alert('Alınamadı', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async (book: Book) => {
    if (!link) return;
    setBusy(book.id);
    try {
      const { name, json } = await exportPackage(db, book);
      await pcUpload(link, name, json);
      Alert.alert('Bilgisayara gönderildi', `“${book.title}” bilgisayardaki Sesli Kitap kitaplığına eklendi.`);
      setItems(await pcLibrary(link));
    } catch (e) {
      Alert.alert('Gönderilemedi', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (link === undefined) return <ActivityIndicator style={{ marginTop: 48 }} color={t.accent} />;

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
      {!link ? (
        <>
          <View style={s.card}>
            <Ionicons name="desktop-outline" size={36} color={t.accent} />
            <Text style={s.h1}>Bilgisayara bağlan</Text>
            <Text style={s.body}>
              Bilgisayarda Sesli Kitap’ı açın ve “Telefonu bağla” bölümündeki karekodu okutun. Telefon ile bilgisayar aynı Wi-Fi ağında olmalı.
            </Text>
            <Pressable style={s.primary} onPress={() => setScanning(true)} testID="pc-scan">
              <Ionicons name="qr-code-outline" size={20} color={t.accentText} />
              <Text style={s.primaryText}>Karekodu tara</Text>
            </Pressable>
          </View>
          <View style={s.card}>
            <Text style={s.h2}>Ya da elle yazın</Text>
            <TextInput value={address} onChangeText={setAddress} placeholder="Adres, ör. 192.168.1.20:47800" placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={s.input} testID="pc-address" />
            <TextInput value={code} onChangeText={setCode} placeholder="Bağlantı kodu" placeholderTextColor={t.muted} autoCapitalize="characters" autoCorrect={false} style={s.input} testID="pc-code" />
            <Pressable style={s.secondary} onPress={manual} testID="pc-connect">
              <Text style={s.secondaryText}>Bağlan</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <View style={s.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name={error ? 'alert-circle-outline' : 'desktop'} size={28} color={error ? t.danger : t.accent} />
              <View style={{ flex: 1 }}>
                <Text style={s.h2} numberOfLines={1} testID="pc-name">
                  {pcName ?? link.name ?? 'Bilgisayar'}
                </Text>
                <Text style={s.small} numberOfLines={1}>
                  {link.url}
                </Text>
              </View>
              <Pressable onPress={refresh} hitSlop={10} accessibilityLabel="Yenile" testID="pc-refresh">
                {loading ? <ActivityIndicator color={t.accent} /> : <Ionicons name="refresh" size={24} color={t.accent} />}
              </Pressable>
            </View>
            {error ? (
              <Text style={[s.body, { color: t.danger }]} testID="pc-error">
                {error}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable style={s.secondary} onPress={() => setScanning(true)} testID="pc-rescan">
                <Text style={s.secondaryText}>Yeniden tara</Text>
              </Pressable>
              <Pressable style={s.secondary} onPress={() => void forget()} testID="pc-forget">
                <Text style={s.secondaryText}>Bağlantıyı kaldır</Text>
              </Pressable>
            </View>
          </View>

          {items ? (
            <View style={{ gap: 8 }}>
              <Text style={s.section}>Bilgisayardaki kitaplar</Text>
              {items.length === 0 ? <Text style={s.body}>Bilgisayardaki kitaplık boş. Bilgisayarda bir PDF ya da sayfa fotoğraflarını dönüştürün.</Text> : null}
              {items.map((it) => (
                <View key={it.id} style={s.row}>
                  <Ionicons name={it.kind === 'audio' ? 'headset-outline' : 'book-outline'} size={22} color={t.accent} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowTitle} numberOfLines={2}>
                      {it.title}
                    </Text>
                    <Text style={s.small}>
                      {it.kind === 'audio' ? `Sesli kitap · ${it.count} bölüm` : `${it.count} sayfa/bölüm`} · {formatSize(it.size)}
                      {it.status === 'downloading' ? ' · bilgisayara iniyor' : ''}
                    </Text>
                  </View>
                  <Pressable onPress={() => void receive(it)} disabled={busy !== null || it.status !== 'ready'} style={[s.small_btn, (busy !== null || it.status !== 'ready') && { opacity: 0.5 }]} testID={`pc-get-${it.kind}-${it.title}`}>
                    {busy === it.id ? <ActivityIndicator color={t.accentText} /> : <Text style={s.smallBtnText}>Telefona al</Text>}
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          {items && phoneBooks.length ? (
            <View style={{ gap: 8 }}>
              <Text style={s.section}>Telefondan bilgisayara gönder</Text>
              {phoneBooks.map((b) => (
                <View key={b.id} style={s.row}>
                  <Ionicons name="phone-portrait-outline" size={22} color={t.muted} />
                  <Text style={[s.rowTitle, { flex: 1 }]} numberOfLines={2}>
                    {b.title}
                  </Text>
                  <Pressable onPress={() => void send(b)} disabled={busy !== null} style={[s.outlineBtn, busy !== null && { opacity: 0.5 }]} testID="pc-send">
                    {busy === b.id ? <ActivityIndicator color={t.accent} /> : <Text style={s.outlineText}>Gönder</Text>}
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}
      <Scanner
        visible={scanning}
        theme={t}
        onClose={() => setScanning(false)}
        onCode={(l) => {
          setScanning(false);
          void connect(l);
        }}
      />
    </ScrollView>
  );
}

function Scanner({ visible, theme, onClose, onCode }: { visible: boolean; theme: Theme; onClose: () => void; onCode: (l: PcLink) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    if (visible) {
      handled.current = false;
      if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {permission?.granted ? (
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              const l = parsePcLink(data);
              if (!l) {
                setWrong(true);
                return;
              }
              handled.current = true;
              onCode(l);
            }}
          />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', padding: 32, gap: 16 }}>
            <Text style={{ color: '#fff', fontSize: 17, textAlign: 'center' }}>Karekodu okutmak için kamera izni gerekiyor.</Text>
            <Pressable onPress={() => void requestPermission()} style={{ backgroundColor: theme.accent, padding: 14, borderRadius: 12, alignItems: 'center' }}>
              <Text style={{ color: theme.accentText, fontSize: 16, fontWeight: '600' }}>İzin ver</Text>
            </Pressable>
          </View>
        )}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center', gap: 12 }}>
          <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center', paddingHorizontal: 24 }}>
            {wrong ? 'Bu karekod Sesli Kitap’a ait değil. Bilgisayardaki karekodu gösterin.' : 'Bilgisayar ekranındaki karekodu çerçeveye alın'}
          </Text>
          <Pressable onPress={onClose} style={{ paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.2)' }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Kapat</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    card: { backgroundColor: t.surface, borderRadius: 16, padding: 16, gap: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    h1: { fontSize: 20, fontWeight: '700', color: t.text },
    h2: { fontSize: 17, fontWeight: '600', color: t.text },
    body: { fontSize: 15, color: t.muted, lineHeight: 21 },
    small: { fontSize: 12, color: t.muted },
    section: { fontSize: 13, fontWeight: '700', color: t.muted, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 4 },
    input: { borderWidth: 1, borderColor: t.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: t.text, backgroundColor: t.bg, fontSize: 16 },
    primary: { flexDirection: 'row', gap: 8, backgroundColor: t.accent, paddingVertical: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    primaryText: { color: t.accentText, fontSize: 17, fontWeight: '600' },
    secondary: { flex: 1, borderWidth: 1, borderColor: t.border, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
    secondaryText: { color: t.text, fontSize: 15, fontWeight: '600' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: t.surface },
    rowTitle: { fontSize: 15, color: t.text, fontWeight: '600' },
    small_btn: { backgroundColor: t.accent, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, minWidth: 96, alignItems: 'center' },
    smallBtnText: { color: t.accentText, fontSize: 14, fontWeight: '600' },
    outlineBtn: { borderWidth: 1, borderColor: t.accent, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, minWidth: 80, alignItems: 'center' },
    outlineText: { color: t.accent, fontSize: 14, fontWeight: '600' },
  });
