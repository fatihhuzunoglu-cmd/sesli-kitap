import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { migrate } from '@/db/database';
import { ExtractorProvider } from '@/engine/ExtractorProvider';
import { useTheme } from '@/ui/theme';

export default function RootLayout() {
  const t = useTheme();
  return (
    <SQLiteProvider databaseName="library.db" onInit={migrate}>
      <ExtractorProvider>
        <StatusBar style="auto" />
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
        </Stack>
      </ExtractorProvider>
    </SQLiteProvider>
  );
}
