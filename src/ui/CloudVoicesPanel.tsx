import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, FileMode, Paths } from 'expo-file-system';
import Ionicons from '@expo/vector-icons/Ionicons';
import { speechLocale } from '@/lib/text';
import { SAMPLE_TEXT } from '@/lib/voices';
import { cloudSettings, getApiKey, setApiKey, setCloudOptions } from '@/tts/cloudSettings';
import { cloudVoiceRef, listCloudVoices, parseCloudVoice, PROVIDERS, synthesizeCloud, type CloudProvider, type CloudVoice } from '@/tts/cloudVoices';
import { getPrefs, updatePrefs, usePrefs } from './prefs';
import type { Theme } from './theme';

// Connects an AI text-to-speech service with the user's own key and lets them pick and hear its voices.
export function CloudVoicesPanel({ theme: t, language, onChosen }: { theme: Theme; language: string; onChosen: () => void }) {
  const s = styles(t);
  const prefs = usePrefs();
  const chosen = parseCloudVoice(prefs.voices[language]);
  const [provider, setProvider] = useState<CloudProvider | null>(chosen?.provider ?? null);
  const [apiKey, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(chosen ? (prefs.cloud[chosen.provider]?.baseUrl ?? '') : '');
  const [model, setModel] = useState(chosen ? (prefs.cloud[chosen.provider]?.model ?? '') : '');
  const [voices, setVoices] = useState<CloudVoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const player = useRef<AudioPlayer | null>(null);

  const info = PROVIDERS.find((p) => p.id === provider);

  const connect = async (p: CloudProvider, key: string, url: string, m: string) => {
    setBusy(true);
    setError(null);
    try {
      if (p !== 'custom' && !key.trim()) throw new Error('Önce API anahtarını girin.');
      await setApiKey(p, key);
      setCloudOptions(p, { baseUrl: url.trim() || undefined, model: m.trim() || undefined });
      const list = await listCloudVoices({ provider: p, apiKey: key.trim(), baseUrl: url.trim(), model: m.trim() }, language);
      if (!list.length) throw new Error('Bu dil için ses bulunamadı.');
      setVoices(list);
    } catch (e) {
      setVoices(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A provider connected before shows its voices straight away.
  const loadProvider = async (p: CloudProvider) => {
    const key = await getApiKey(p);
    setKey(key);
    const extra = getPrefs().cloud[p] ?? {};
    if (key || (p === 'custom' && extra.baseUrl)) await connect(p, key, extra.baseUrl ?? '', extra.model ?? '');
  };

  const selectProvider = (p: CloudProvider) => {
    const extra = prefs.cloud[p] ?? {};
    setProvider(p);
    setVoices(null);
    setError(null);
    setKey('');
    setBaseUrl(extra.baseUrl ?? '');
    setModel(extra.model ?? '');
    void loadProvider(p);
  };

  useEffect(() => {
    if (chosen) void getApiKey(chosen.provider).then(() => loadProvider(chosen.provider));
    return () => {
      player.current?.remove();
    };
    // Once per language: the parent remounts the panel when the language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = async (voice: CloudVoice) => {
    if (!provider) return;
    setPreviewing(voice.id);
    setError(null);
    try {
      const audio = await synthesizeCloud(await cloudSettings(provider), voice.id, SAMPLE_TEXT[language] ?? SAMPLE_TEXT.en, speechLocale(language));
      const file = new File(Paths.cache, `cloud-preview.${audio.ext}`);
      file.create({ overwrite: true });
      const handle = file.open(FileMode.ReadWrite);
      try {
        await handle.writeBytes(audio.bytes);
      } finally {
        handle.close();
      }
      player.current?.remove();
      player.current = createAudioPlayer({ uri: file.uri });
      player.current.play();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(null);
    }
  };

  const choose = (voice: CloudVoice) => {
    if (!provider) return;
    updatePrefs({ voices: { ...prefs.voices, [language]: cloudVoiceRef(provider, voice.id) } });
    onChosen();
    void preview(voice);
  };

  return (
    <View style={s.card} testID="cloud-panel">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="sparkles-outline" size={20} color={t.accent} />
        <Text style={s.title}>Yapay zekâ sesleri</Text>
      </View>
      <Text style={s.body}>
        İnsan sesine en yakın okuma için bir yapay zekâ ses hizmetini kendi anahtarınızla bağlayın. Metin cümle cümle doğrudan seçtiğiniz
        hizmete gönderilir; internet gerekir ve hizmet kullanımınızı ücretlendirebilir. Anahtarınız yalnızca bu telefonun güvenli
        deposunda saklanır.
      </Text>
      <View style={s.wrap}>
        {PROVIDERS.map((p) => (
          <Pressable key={p.id} onPress={() => selectProvider(p.id)} style={[s.pill, provider === p.id && s.pillActive]} testID={`cloud-provider-${p.id}`}>
            <Text style={[s.pillText, provider === p.id && { color: t.accentText }]}>{p.id === 'custom' ? 'Diğer (OpenAI uyumlu)' : p.label}</Text>
          </Pressable>
        ))}
      </View>
      {info ? (
        <View style={{ gap: 10 }}>
          <Text style={s.small}>{info.detail}</Text>
          {provider === 'custom' ? (
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="Sunucu adresi (ör. https://sunucum.com)"
              placeholderTextColor={t.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={s.input}
              testID="cloud-base-url"
            />
          ) : null}
          <TextInput
            value={apiKey}
            onChangeText={setKey}
            placeholder={provider === 'custom' ? 'API anahtarı (varsa)' : 'API anahtarı'}
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={s.input}
            testID="cloud-api-key"
          />
          {provider === 'openai' || provider === 'custom' || provider === 'elevenlabs' ? (
            <TextInput
              value={model}
              onChangeText={setModel}
              placeholder={provider === 'openai' ? 'Model (varsayılan gpt-4o-mini-tts)' : provider === 'elevenlabs' ? 'Model (varsayılan eleven_multilingual_v2)' : 'Model (varsayılan tts-1)'}
              placeholderTextColor={t.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={s.input}
              testID="cloud-model"
            />
          ) : null}
          <Text style={s.small}>{info.keyHint}</Text>
          <Pressable style={s.button} onPress={() => connect(provider!, apiKey, baseUrl, model)} disabled={busy} testID="cloud-connect">
            {busy ? <ActivityIndicator color={t.accentText} /> : <Ionicons name="link-outline" size={18} color={t.accentText} />}
            <Text style={s.buttonText}>Bağlan ve sesleri getir</Text>
          </Pressable>
          {error ? (
            <Text style={[s.small, { color: t.danger }]} testID="cloud-error">
              {error}
            </Text>
          ) : null}
          {voices?.map((v) => {
            const selected = chosen?.provider === provider && chosen.voiceId === v.id;
            return (
              <Pressable
                key={v.id}
                onPress={() => choose(v)}
                style={[s.voice, selected && { backgroundColor: t.highlight }]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                testID={`cloud-voice-${v.id}`}
              >
                <Ionicons name={previewing === v.id ? 'volume-high-outline' : 'sparkles-outline'} size={22} color={t.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{v.name}</Text>
                  <Text style={s.small} numberOfLines={1}>
                    {v.detail}
                  </Text>
                </View>
                {selected ? <Ionicons name="checkmark" size={22} color={t.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    card: { padding: 16, borderRadius: 14, backgroundColor: t.surface, gap: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    title: { color: t.text, fontSize: 17, fontWeight: '700' },
    body: { color: t.muted, fontSize: 14, lineHeight: 20 },
    small: { color: t.muted, fontSize: 13, lineHeight: 18 },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg },
    pillActive: { backgroundColor: t.accent, borderColor: t.accent },
    pillText: { color: t.text, fontWeight: '600' },
    input: { borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: t.text, backgroundColor: t.bg, fontSize: 15 },
    button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: t.accent, paddingVertical: 12, borderRadius: 10 },
    buttonText: { color: t.accentText, fontWeight: '700' },
    voice: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  });
