import { requireOptionalNativeModule } from 'expo';

type TranslatorNative = {
  // False where on-device translation is unavailable (iOS before 18).
  isSupported(): boolean;
  // ISO 639-1 code of the dominant language, or "und" when it cannot be told.
  identifyLanguage(text: string): Promise<string>;
  // Downloads the language models if needed; on iOS the system may ask the user to confirm the download.
  prepare(source: string, target: string): Promise<void>;
  translate(texts: string[], source: string, target: string): Promise<string[]>;
};

// On-device translation: Apple's Translation framework on iOS, ML Kit on Android. Null in Expo Go.
export const Translator = requireOptionalNativeModule<TranslatorNative>('Translator');
