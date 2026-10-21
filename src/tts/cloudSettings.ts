import * as SecureStore from 'expo-secure-store';
import { getPrefs, updatePrefs } from '@/ui/prefs';
import type { CloudProvider, CloudSettings } from './cloudVoices';

// API keys live in the system keychain (iOS Keychain / Android Keystore), never in the app's database.
const keyName = (provider: CloudProvider) => `cloud-key-${provider}`;
const cache = new Map<CloudProvider, string>();

export async function getApiKey(provider: CloudProvider): Promise<string> {
  if (cache.has(provider)) return cache.get(provider)!;
  const key = (await SecureStore.getItemAsync(keyName(provider)).catch(() => null)) ?? '';
  cache.set(provider, key);
  return key;
}

export async function setApiKey(provider: CloudProvider, key: string) {
  const trimmed = key.trim();
  cache.set(provider, trimmed);
  if (trimmed) await SecureStore.setItemAsync(keyName(provider), trimmed);
  else await SecureStore.deleteItemAsync(keyName(provider));
}

// Everything needed to call a provider: the key from the keychain, the server and model from the preferences.
export async function cloudSettings(provider: CloudProvider): Promise<CloudSettings> {
  const extra = getPrefs().cloud[provider] ?? {};
  return { provider, apiKey: await getApiKey(provider), baseUrl: extra.baseUrl, model: extra.model };
}

export function setCloudOptions(provider: CloudProvider, options: { baseUrl?: string; model?: string }) {
  const cloud = getPrefs().cloud;
  updatePrefs({ cloud: { ...cloud, [provider]: { ...cloud[provider], ...options } } });
}
