import { Alert, Pressable, Text, View } from 'react-native';
import { useEffect } from 'react';
import { setAudioModeAsync } from 'expo-audio';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrate } from '@/db/database';
import { ExtractorProvider } from '@/engine/ExtractorProvider';
import { loadPrefs } from '@/ui/prefs';
import { useTheme } from '@/ui/theme';

// Release builds terminate on uncaught JS errors; show the message instead so it can be reported.
if (!__DEV__) {
  ErrorUtils.setGlobalHandler((error) => {
    Alert.alert('Beklenmeyen hata', `${(error as Error)?.message ?? String(error)}\n\nLütfen bu ekranın görüntüsünü gönderin.`);
  });
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, justifyContent: 'center', padding: 24, gap: 16 }}>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Bir hata oluştu</Text>
      <Text style={{ color: t.muted, fontSize: 15 }} selectable>
        {error.message}
      </Text>
      <Pressable onPress={retry} style={{ backgroundColor: t.accent, padding: 14, borderRadius: 12, alignItems: 'center' }}>
        <Text style={{ color: t.accentText, fontSize: 16, fontWeight: '600' }}>Tekrar dene</Text>
      </Pressable>
    </View>
  );
}

async function init(db: SQLiteDatabase) {
  await migrate(db);
  await loadPrefs(db);
}

export default function RootLayout() {
  const t = useTheme();
  useEffect(() => {
    // Playback category: speech is audible with the silent switch on and keeps going when the screen locks.
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' });
  }, []);
  return (
    <SQLiteProvider databaseName="library.db" onInit={init}>
      <ExtractorProvider>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.bg },
            headerTintColor: t.text,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.bg },
          }}
        >
          <Stack.Screen name="index" options={{ title: 'Kitaplığım' }} />
          <Stack.Screen name="reader/[id]" options={{ title: '' }} />
          <Stack.Screen name="voices" options={{ title: 'Sesler' }} />
          <Stack.Screen name="settings" options={{ title: 'Ayarlar' }} />
          <Stack.Screen name="audio/[id]" options={{ title: '' }} />
          <Stack.Screen name="discover" options={{ title: 'İnternetten bul' }} />
          <Stack.Screen name="pc" options={{ title: 'Bilgisayar' }} />
        </Stack>
      </ExtractorProvider>
    </SQLiteProvider>
  );
}
