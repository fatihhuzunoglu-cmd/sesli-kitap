import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { SpeechFile, type NativeVoice } from '../../modules/speech-file';

export type VoiceEntry = NativeVoice & { label: string; detail: string };

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
  { code: 'az', label: 'Azərbaycanca' },
  { code: 'fa', label: 'فارسی' },
];

export function languageLabel(code: string) {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

const QUALITY_RANK = { premium: 0, enhanced: 1, default: 2 } as const;
export const QUALITY_LABEL = { premium: 'Premium', enhanced: 'Gelişmiş', default: 'Standart' } as const;

function region(tag: string) {
  const parts = tag.replace('_', '-').split('-');
  return parts[1]?.toUpperCase() ?? '';
}

// Google voice ids look like "tr-tr-x-cfs-local"; give them a readable, stable name.
function androidLabel(v: NativeVoice, index: number) {
  const m = v.id.match(/-x-([a-z]{3})-/);
  const variant = m ? m[1].toUpperCase() : String(index + 1);
  return `Ses ${variant}`;
}

export async function loadVoices(): Promise<VoiceEntry[]> {
  let raw: NativeVoice[];
  if (SpeechFile) {
    raw = await SpeechFile.getVoices();
  } else {
    const voices = await Speech.getAvailableVoicesAsync();
    raw = voices.map((v) => ({
      id: v.identifier,
      name: v.name,
      language: v.language,
      quality: v.quality === 'Enhanced' ? 'enhanced' : 'default',
      gender: 'unspecified',
      network: false,
      installed: true,
    }));
  }
  const counters = new Map<string, number>();
  return raw
    .map((v) => {
      const lang = v.language.toLowerCase().replace('_', '-');
      const n = counters.get(lang) ?? 0;
      counters.set(lang, n + 1);
      const label = Platform.OS === 'android' ? androidLabel(v, n) : v.name;
      const bits: string[] = [QUALITY_LABEL[v.quality]];
      if (v.gender === 'female') bits.push('Kadın');
      if (v.gender === 'male') bits.push('Erkek');
      const r = region(v.language);
      if (r) bits.push(r);
      if (v.network) bits.push('İnternet gerekir');
      if (!v.installed) bits.push('İndirilmemiş');
      return { ...v, language: lang, label, detail: bits.join(' · ') };
    })
    .sort((a, b) => QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] || Number(a.network) - Number(b.network) || a.label.localeCompare(b.label));
}

export function voicesFor(all: VoiceEntry[], language: string) {
  return all.filter((v) => v.language === language || v.language.startsWith(`${language}-`));
}

export function bestVoice(all: VoiceEntry[], language: string): VoiceEntry | undefined {
  return voicesFor(all, language).find((v) => v.installed && !v.network) ?? voicesFor(all, language)[0];
}

export const SAMPLE_TEXT: Record<string, string> = {
  tr: 'Merhaba! Kitabınızı bu sesle okuyacağım. Hız ve tonu dilediğiniz gibi ayarlayabilirsiniz.',
  en: 'Hello! I will read your book with this voice. You can adjust the speed and pitch as you like.',
  de: 'Hallo! Ich lese Ihr Buch mit dieser Stimme vor.',
  fr: 'Bonjour ! Je vais lire votre livre avec cette voix.',
  es: '¡Hola! Leeré tu libro con esta voz.',
  it: 'Ciao! Leggerò il tuo libro con questa voce.',
  pt: 'Olá! Vou ler o seu livro com esta voz.',
  nl: 'Hallo! Ik lees je boek voor met deze stem.',
  ru: 'Здравствуйте! Я прочитаю вашу книгу этим голосом.',
  ar: 'مرحبا! سأقرأ كتابك بهذا الصوت.',
  az: 'Salam! Kitabınızı bu səslə oxuyacağam.',
  fa: 'سلام! کتاب شما را با این صدا می‌خوانم.',
};
