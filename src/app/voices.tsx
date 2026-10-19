import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import * as Speech from 'expo-speech';
import * as IntentLauncher from 'expo-intent-launcher';
import Slider from '@react-native-community/slider';
import Ionicons from '@expo/vector-icons/Ionicons';
import { updateBook } from '@/db/database';
import { notifyBooksChanged } from '@/engine/booksEvents';
import { speechLocale } from '@/lib/text';
import { LANGUAGES, loadVoices, QUALITY_LABEL, SAMPLE_TEXT, voicesFor, type VoiceEntry } from '@/lib/voices';
import { updatePrefs, usePrefs } from '@/ui/prefs';
import { useTheme, type Theme } from '@/ui/theme';

export default function VoicesScreen() {
  const params = useLocalSearchParams<{ language?: string; bookId?: string }>();
  const db = useSQLiteContext();
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const prefs = usePrefs();
  const [language, setLanguage] = useState(params.language || 'tr');
  const [all, setAll] = useState<VoiceEntry[] | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  const reload = useCallback(() => {
    void loadVoices().then(setAll);
  }, []);

  useEffect(() => {
    reload();
    return () => {
      void Speech.stop();
    };
  }, [reload]);

  const list = useMemo(() => (all ? voicesFor(all, language) : []), [all, language]);
  const selected = prefs.voices[language] ?? null;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    all?.forEach((v) => m.set(v.language.split('-')[0], (m.get(v.language.split('-')[0]) ?? 0) + 1));
    return m;
  }, [all]);

  const preview = (voice: VoiceEntry | null, pitch = prefs.pitch) => {
    void Speech.stop();
    setPreviewing(voice?.id ?? 'default');
    Speech.speak(SAMPLE_TEXT[language] ?? SAMPLE_TEXT.en, {
      voice: voice?.id,
      language: speechLocale(language),
      pitch,
      rate: Math.min(prefs.rate, 2),
      useApplicationAudioSession: true,
      onDone: () => setPreviewing(null),
      onStopped: () => setPreviewing(null),
      onError: () => setPreviewing(null),
    });
  };

  const choose = (voice: VoiceEntry | null) => {
    const voices = { ...prefs.voices };
    if (voice) voices[language] = voice.id;
    else delete voices[language];
    updatePrefs({ voices });
    preview(voice);
  };

  const changeLanguage = async (code: string) => {
    setLanguage(code);
    if (params.bookId) {
      await updateBook(db, params.bookId, { language: code });
      notifyBooksChanged();
    }
  };

  const openSystemVoices = () => {
    if (Platform.OS === 'android') {
      void IntentLauncher.startActivityAsync('com.android.settings.TTS_SETTINGS').catch(() => Linking.openSettings());
    } else {
      void Linking.openSettings();
    }
  };

  return (
    <View style={s.root}>
      <Stack.Screen options={{ title: 'Sesler' }} />
      <FlatList
        data={list}
        keyExtractor={(v) => v.id}
        contentContainerStyle={s.content}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text style={s.label}>{params.bookId ? 'Kitabın dili' : 'Dil'}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {LANGUAGES.map((l) => (
                <Pressable
                  key={l.code}
                  onPress={() => changeLanguage(l.code)}
                  style={[s.chip, l.code === language && { backgroundColor: t.accent, borderColor: t.accent }]}
                  testID={`lang-${l.code}`}
                >
                  <Text style={{ color: l.code === language ? t.accentText : t.text, fontWeight: '600' }}>
                    {l.label}
                    {counts.get(l.code) ? ` · ${counts.get(l.code)}` : ''}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <Text style={s.label}>Ses tonu · {prefs.pitch.toFixed(2)}</Text>
            <View style={s.sliderRow}>
              <Text style={s.small}>Kalın</Text>
              <Slider
                style={{ flex: 1 }}
                minimumValue={0.5}
                maximumValue={2}
                step={0.05}
                value={prefs.pitch}
                minimumTrackTintColor={t.accent}
                maximumTrackTintColor={t.border}
                thumbTintColor={t.accent}
                onSlidingComplete={(v) => {
                  updatePrefs({ pitch: Math.round(v * 100) / 100 });
                  preview(list.find((x) => x.id === selected) ?? null, v);
                }}
                testID="pitch-slider"
              />
              <Text style={s.small}>İnce</Text>
            </View>
            <Pressable onPress={() => updatePrefs({ pitch: 1 })}>
              <Text style={s.link}>Tonu sıfırla</Text>
            </Pressable>

            <Text style={s.label}>Ses seçin (dokununca dinlersiniz)</Text>
            <VoiceRow
              theme={t}
              title="Sistem varsayılanı"
              detail="Telefonun bu dil için seçtiği ses"
              selected={!selected}
              previewing={previewing === 'default'}
              onPress={() => choose(null)}
              testID="voice-default"
            />
          </View>
        }
        ListEmptyComponent={
          all === null ? (
            <ActivityIndicator style={{ marginTop: 24 }} color={t.accent} />
          ) : (
            <Text style={s.notice}>Bu dil için cihazda yüklü ses bulunamadı. Aşağıdaki adımlarla ücretsiz ses indirebilirsiniz.</Text>
          )
        }
        renderItem={({ item }) => (
          <VoiceRow
            theme={t}
            title={item.label}
            detail={item.detail}
            badge={item.quality === 'premium' ? QUALITY_LABEL.premium : undefined}
            selected={item.id === selected}
            previewing={previewing === item.id}
            onPress={() => choose(item)}
            testID={`voice-${item.id}`}
          />
        )}
        ListFooterComponent={
          <View style={s.help}>
            <Text style={s.helpTitle}>Daha doğal sesler indirin (ücretsiz)</Text>
            {Platform.OS === 'ios' ? (
              <Text style={s.helpBody}>
                Ayarlar → Erişilebilirlik → Seslendirilen İçerik → Sesler → {LANGUAGES.find((l) => l.code === language)?.label ?? language} yolunu izleyin ve
                “Gelişmiş” ya da “Premium” sesleri indirin (ör. Türkçe için Yelda Gelişmiş). İndirdikten sonra bu ekrana dönüp yenileyin.
              </Text>
            ) : (
              <Text style={s.helpBody}>
                Ayarlar → Sistem → Diller → Metin okuma çıkışı → Google Metin Okuma Motoru → Ses verilerini yükle yolundan dilinizi seçip
                yüksek kaliteli sesleri indirin. Ardından bu ekranı yenileyin.
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <Pressable style={s.button} onPress={openSystemVoices}>
                <Ionicons name="settings-outline" size={18} color={t.accentText} />
                <Text style={s.buttonText}>{Platform.OS === 'android' ? 'Ses ayarlarını aç' : 'Ayarları aç'}</Text>
              </Pressable>
              <Pressable style={[s.button, { backgroundColor: t.bg, borderWidth: 1, borderColor: t.border }]} onPress={reload}>
                <Ionicons name="reload" size={18} color={t.text} />
                <Text style={[s.buttonText, { color: t.text }]}>Listeyi yenile</Text>
              </Pressable>
            </View>
          </View>
        }
      />
    </View>
  );
}

function VoiceRow({
  theme,
  title,
  detail,
  badge,
  selected,
  previewing,
  onPress,
  testID,
}: {
  theme: Theme;
  title: string;
  detail: string;
  badge?: string;
  selected: boolean;
  previewing: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 14,
        borderRadius: 14,
        marginBottom: 8,
        backgroundColor: selected ? theme.highlight : theme.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={previewing ? 'volume-high-outline' : 'person-circle-outline'} size={28} color={theme.accent} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
            {title}
          </Text>
          {badge ? (
            <Text style={{ color: theme.accentText, backgroundColor: theme.accent, fontSize: 11, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' }}>
              {badge}
            </Text>
          ) : null}
        </View>
        <Text style={{ color: theme.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {selected ? <Ionicons name="checkmark" size={22} color={theme.accent} /> : null}
    </Pressable>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    content: { padding: 16, maxWidth: 760, width: '100%', alignSelf: 'center' },
    label: { color: t.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
    chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface },
    sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    small: { color: t.muted, fontSize: 13 },
    link: { color: t.accent, fontWeight: '600' },
    notice: { color: t.muted, fontSize: 15, lineHeight: 22, paddingVertical: 12 },
    help: { marginTop: 16, padding: 16, borderRadius: 14, backgroundColor: t.surface, gap: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    helpTitle: { color: t.text, fontSize: 16, fontWeight: '700' },
    helpBody: { color: t.muted, fontSize: 14, lineHeight: 21 },
    button: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.accent, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
    buttonText: { color: t.accentText, fontWeight: '600' },
  });
