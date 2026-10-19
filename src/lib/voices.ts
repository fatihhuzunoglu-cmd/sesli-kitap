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

export const QUALITY_LABEL = { premium: 'Premium', enhanced: 'Gelişmiş', default: 'Standart' } as const;

const REGIONS: Record<string, string> = {
  TR: 'Türkiye', US: 'ABD', GB: 'Birleşik Krallık', AU: 'Avustralya', IN: 'Hindistan', NG: 'Nijerya', CA: 'Kanada',
  IE: 'İrlanda', ZA: 'Güney Afrika', NZ: 'Yeni Zelanda', SG: 'Singapur', DE: 'Almanya', AT: 'Avusturya', CH: 'İsviçre',
  FR: 'Fransa', BE: 'Belçika', ES: 'İspanya', MX: 'Meksika', AR: 'Arjantin', CO: 'Kolombiya', IT: 'İtalya', PT: 'Portekiz',
  BR: 'Brezilya', NL: 'Hollanda', RU: 'Rusya', SA: 'Suudi Arabistan', EG: 'Mısır', AE: 'BAE', AZ: 'Azerbaycan', IR: 'İran',
};

function region(tag: string) {
  const parts = tag.replace('_', '-').split('-');
  const r = parts.find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p));
  return r ? r.toUpperCase() : '';
}

// Google voice ids look like "tr-tr-x-cfs-local"; turn them into "Türkiye · CFS". Apple voices already have names.
function voiceLabel(v: NativeVoice) {
  if (Platform.OS !== 'android') return v.name;
  const r = region(v.language);
  const place = REGIONS[r] ?? r;
  const variant = v.id.match(/-x-([a-z]{3})-/)?.[1]?.toUpperCase();
  if (variant) return place ? `${place} · ${variant}` : variant;
  return place ? `${place} · Varsayılan` : 'Varsayılan';
}

function availability(v: NativeVoice) {
  if (!v.installed) return 2;
  return v.network ? 1 : 0;
}

const QUALITY_RANK = { premium: 0, enhanced: 1, default: 2 } as const;

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
  return raw
    .map((v) => {
      const bits: string[] = [QUALITY_LABEL[v.quality]];
      if (v.gender === 'female') bits.push('Kadın');
      if (v.gender === 'male') bits.push('Erkek');
      if (Platform.OS !== 'android' && region(v.language)) bits.push(REGIONS[region(v.language)] ?? region(v.language));
      bits.push(!v.installed ? 'İndirilmesi gerekir' : v.network ? 'İnternetle çalışır' : 'İnternetsiz çalışır');
      return { ...v, language: v.language.toLowerCase().replace('_', '-'), label: voiceLabel(v), detail: bits.join(' · ') };
    })
    .sort(
      (a, b) =>
        availability(a) - availability(b) ||
        Number(region(b.language) === b.language.split('-')[0].toUpperCase()) - Number(region(a.language) === a.language.split('-')[0].toUpperCase()) ||
        QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] ||
        a.label.localeCompare(b.label, 'tr'),
    );
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
