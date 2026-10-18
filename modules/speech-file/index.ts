import { requireOptionalNativeModule } from 'expo';

export type VoiceQuality = 'default' | 'enhanced' | 'premium';

export type NativeVoice = {
  id: string;
  name: string;
  language: string;
  quality: VoiceQuality;
  gender: 'male' | 'female' | 'unspecified';
  network: boolean;
  installed: boolean;
};

export type SynthesizeOptions = { voiceId?: string | null; language?: string | null; pitch?: number };
export type SynthesizeResult = { durationMs: number; written: boolean };

type SpeechFileNative = {
  fileExtension: string;
  getVoices(): Promise<NativeVoice[]>;
  synthesize(text: string, path: string, options: SynthesizeOptions): Promise<SynthesizeResult>;
  cancelPending(): Promise<void>;
};

// Null in Expo Go, where the app falls back to live expo-speech playback.
export const SpeechFile = requireOptionalNativeModule<SpeechFileNative>('SpeechFile');
