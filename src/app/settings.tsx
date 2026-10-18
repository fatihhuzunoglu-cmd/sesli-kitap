import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as Speech from 'expo-speech';
import Ionicons from '@expo/vector-icons/Ionicons';
import { applyPronunciations, speechLocale } from '@/lib/text';
import { usesAudioPipeline } from '@/tts/useNarrator';
import { updatePrefs, usePrefs } from '@/ui/prefs';
import { useTheme, type Theme } from '@/ui/theme';

export default function SettingsScreen() {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const prefs = usePrefs();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const add = () => {
    if (!from.trim() || !to.trim()) return;
    const rest = prefs.pronunciations.filter((p) => p.from.toLocaleLowerCase('tr') !== from.trim().toLocaleLowerCase('tr'));
    updatePrefs({ pronunciations: [...rest, { from: from.trim(), to: to.trim() }] });
    setFrom('');
    setTo('');
  };

  const test = (text: string) => {
    void Speech.stop();
    Speech.speak(applyPronunciations(text, prefs.pronunciations), {
      language: speechLocale('tr'),
      voice: prefs.voices.tr,
      pitch: prefs.pitch,
      useApplicationAudioSession: true,
    });
  };

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Pressable style={s.card} onPress={() => router.push({ pathname: '/voices', params: { language: 'tr' } })} testID="settings-voices">
        <Ionicons name="person-circle-outline" size={26} color={t.accent} />
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>Sesler</Text>
          <Text style={s.cardBody}>Her dil için okuma sesini ve ses tonunu seçin.</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={t.muted} />
      </Pressable>

      <Text style={s.label}>Telaffuz sözlüğü</Text>
      <Text style={s.cardBody}>
        Sesin yanlış okuduğu kelimeleri düzeltin. Örneğin “Dr.” → “Doktor”, “Shakespeare” → “Şekspir”. Tüm kitaplarda geçerlidir.
      </Text>
      <View style={s.formRow}>
        <TextInput value={from} onChangeText={setFrom} placeholder="Yazılışı" placeholderTextColor={t.muted} style={s.input} autoCapitalize="none" testID="pron-from" />
        <Ionicons name="arrow-forward" size={18} color={t.muted} />
        <TextInput value={to} onChangeText={setTo} placeholder="Okunuşu" placeholderTextColor={t.muted} style={s.input} onSubmitEditing={add} testID="pron-to" />
        <Pressable onPress={add} style={s.addBtn} accessibilityLabel="Ekle" testID="pron-add">
          <Ionicons name="add" size={22} color={t.accentText} />
        </Pressable>
      </View>
      {prefs.pronunciations.map((p) => (
        <View key={p.from} style={s.entry}>
          <Text style={[s.cardBody, { flex: 1, color: t.text }]}>
            {p.from} → {p.to}
          </Text>
          <Pressable hitSlop={10} onPress={() => test(p.from)} accessibilityLabel="Dinle">
            <Ionicons name="volume-high-outline" size={20} color={t.accent} />
          </Pressable>
          <Pressable hitSlop={10} onPress={() => updatePrefs({ pronunciations: prefs.pronunciations.filter((x) => x !== p) })} accessibilityLabel="Sil">
            <Ionicons name="trash-outline" size={20} color={t.muted} />
          </Pressable>
        </View>
      ))}

      <Text style={s.label}>Hakkında</Text>
      <Text style={s.cardBody}>
        Sesli Kitap {Constants.expoConfig?.version ?? ''} · Okuma motoru: {usesAudioPipeline ? 'kilit ekranı destekli ses akışı' : 'canlı okuma (Expo Go)'}
      </Text>
      <Text style={s.cardBody}>Tüm kitaplarınız ve ayarlarınız yalnızca bu cihazda saklanır.</Text>
    </ScrollView>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    content: { padding: 16, gap: 12, maxWidth: 760, width: '100%', alignSelf: 'center' },
    label: { color: t.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12 },
    card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 14, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    cardTitle: { color: t.text, fontSize: 17, fontWeight: '600' },
    cardBody: { color: t.muted, fontSize: 14, lineHeight: 20 },
    formRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    input: { flex: 1, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: t.text, backgroundColor: t.surface, fontSize: 15 },
    addBtn: { backgroundColor: t.accent, borderRadius: 10, padding: 10 },
    entry: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 12, borderRadius: 10, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  });
