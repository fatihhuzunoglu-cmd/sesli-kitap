// Cloud "AI" voices: the reader can use a text-to-speech service the user connects with their own API key.
// Requests go straight from the phone to the provider; nothing passes through any other server.

export type CloudProvider = 'google' | 'openai' | 'elevenlabs' | 'custom';

export type CloudSettings = {
  provider: CloudProvider;
  apiKey: string;
  // Only for 'custom': an OpenAI-compatible server, e.g. https://my-server.example.com (the /v1 part is added).
  baseUrl?: string;
  // Model for OpenAI and OpenAI-compatible servers.
  model?: string;
};

export type CloudVoice = { id: string; name: string; detail: string };

export const PROVIDERS: { id: CloudProvider; label: string; detail: string; keyHint: string }[] = [
  {
    id: 'google',
    label: 'Google Cloud',
    detail: 'Chirp 3 HD, Neural2 ve WaveNet sesleri; Türkçe dahil çok dil',
    keyHint: 'Google Cloud Console → Text-to-Speech API’yi etkinleştirin → API anahtarı oluşturun',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    detail: 'gpt-4o-mini-tts: çok dilli, doğal ve duygulu sesler',
    keyHint: 'platform.openai.com → API keys → yeni anahtar',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    detail: 'Çok dilli v2 modeli, insana çok yakın sesler',
    keyHint: 'elevenlabs.io → Profile → API key',
  },
  {
    id: 'custom',
    label: 'Başka bir yapay zekâ (OpenAI uyumlu)',
    detail: 'OpenAI ses API’siyle uyumlu herhangi bir sunucu',
    keyHint: 'Sunucunuzun adresi ve (varsa) anahtarı',
  },
];

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export const CLOUD_PREFIX = 'cloud:';

// Voices are stored per language as "cloud:<provider>:<voice id>".
export function cloudVoiceRef(provider: CloudProvider, voiceId: string) {
  return `${CLOUD_PREFIX}${provider}:${voiceId}`;
}

export function parseCloudVoice(ref: string | null | undefined): { provider: CloudProvider; voiceId: string } | null {
  if (!ref?.startsWith(CLOUD_PREFIX)) return null;
  const rest = ref.slice(CLOUD_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  return { provider: rest.slice(0, colon) as CloudProvider, voiceId: rest.slice(colon + 1) };
}

export class CloudVoiceError extends Error {}

function openAiBase(s: CloudSettings) {
  const base = s.provider === 'custom' ? (s.baseUrl ?? '').trim().replace(/\/+$/, '') : 'https://api.openai.com';
  if (!/^https?:\/\//.test(base)) throw new CloudVoiceError('Sunucu adresi http:// veya https:// ile başlamalı.');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

async function failure(res: Response): Promise<never> {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? body?.detail?.message ?? body?.detail ?? '';
  } catch {}
  if (res.status === 401 || res.status === 403) throw new CloudVoiceError('API anahtarı geçersiz ya da bu hizmete yetkisi yok.');
  if (res.status === 429) throw new CloudVoiceError('Hizmetin kullanım sınırına ulaşıldı. Biraz sonra tekrar deneyin.');
  throw new CloudVoiceError(`Ses hizmeti hata verdi (${res.status})${detail ? `: ${String(detail).slice(0, 160)}` : ''}`);
}

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Google's voice types, best first.
const GOOGLE_TIERS = ['Chirp3-HD', 'Chirp-HD', 'Studio', 'Neural2', 'Wavenet', 'Standard'];

function googleTier(name: string) {
  const i = GOOGLE_TIERS.findIndex((t) => name.includes(`-${t}-`));
  return i < 0 ? GOOGLE_TIERS.length : i;
}

// Voices the provider offers for `language` (ISO 639-1, e.g. "tr").
export async function listCloudVoices(s: CloudSettings, language: string, fetchFn: typeof fetch = fetch): Promise<CloudVoice[]> {
  switch (s.provider) {
    case 'google': {
      const res = await fetchFn(`https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(language)}&key=${encodeURIComponent(s.apiKey)}`);
      if (!res.ok) await failure(res);
      const body = (await res.json()) as { voices?: { name: string; ssmlGender?: string; languageCodes?: string[] }[] };
      return (body.voices ?? [])
        .filter((v) => (v.languageCodes ?? []).some((c) => c.split('-')[0] === language))
        .sort((a, b) => googleTier(a.name) - googleTier(b.name) || a.name.localeCompare(b.name))
        .map((v) => ({
          id: v.name,
          name: v.name.split('-').slice(-1)[0],
          detail: `${GOOGLE_TIERS[googleTier(v.name)] ?? 'Google'} · ${v.ssmlGender === 'FEMALE' ? 'Kadın' : v.ssmlGender === 'MALE' ? 'Erkek' : 'Ses'} · ${v.languageCodes?.[0] ?? language}`,
        }));
    }
    case 'openai':
      return OPENAI_VOICES.map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1), detail: 'OpenAI · çok dilli' }));
    case 'elevenlabs': {
      const res = await fetchFn('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': s.apiKey } });
      if (!res.ok) await failure(res);
      const body = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
      return (body.voices ?? []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        detail: ['ElevenLabs', v.labels?.gender, v.labels?.accent].filter(Boolean).join(' · '),
      }));
    }
    case 'custom': {
      // OpenAI-compatible servers rarely list voices; offer OpenAI's names, which most of them accept.
      const res = await fetchFn(`${openAiBase(s)}/audio/voices`, { headers: authHeaders(s) }).catch(() => null);
      if (res?.ok) {
        const body = (await res.json().catch(() => null)) as { voices?: (string | { id?: string; name?: string })[] } | null;
        const voices = (body?.voices ?? [])
          .map((v) => (typeof v === 'string' ? v : (v.id ?? v.name ?? '')))
          .filter(Boolean);
        if (voices.length) return voices.map((v) => ({ id: v, name: v, detail: 'Özel sunucu' }));
      }
      return OPENAI_VOICES.map((v) => ({ id: v, name: v, detail: 'Özel sunucu' }));
    }
  }
}

function authHeaders(s: CloudSettings): Record<string, string> {
  return s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {};
}

export type CloudAudio = { bytes: Uint8Array; ext: 'mp3' | 'wav' | 'aac' | 'flac' };

// File type of an audio response; servers that ignore the requested MP3 usually say what they sent instead.
export function audioExt(contentType: string | null): CloudAudio['ext'] {
  const t = (contentType ?? '').toLowerCase();
  if (t.includes('wav')) return 'wav';
  if (t.includes('aac') || t.includes('mp4')) return 'aac';
  if (t.includes('flac')) return 'flac';
  return 'mp3';
}

// Speaks one sentence with the chosen cloud voice.
export async function synthesizeCloud(
  s: CloudSettings,
  voiceId: string,
  text: string,
  locale: string,
  fetchFn: typeof fetch = fetch,
): Promise<CloudAudio> {
  switch (s.provider) {
    case 'google': {
      // Chirp voices take no pitch; speed is applied by the player, so the audio stays at normal speed.
      const res = await fetchFn(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(s.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text }, voice: { languageCode: locale, name: voiceId }, audioConfig: { audioEncoding: 'MP3' } }),
      });
      if (!res.ok) await failure(res);
      const body = (await res.json()) as { audioContent?: string };
      if (!body.audioContent) throw new CloudVoiceError('Ses hizmeti boş yanıt verdi.');
      return { bytes: base64ToBytes(body.audioContent), ext: 'mp3' };
    }
    case 'openai':
    case 'custom': {
      const res = await fetchFn(`${openAiBase(s)}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(s) },
        body: JSON.stringify({
          model: s.model?.trim() || (s.provider === 'openai' ? 'gpt-4o-mini-tts' : 'tts-1'),
          voice: voiceId,
          input: text,
          response_format: 'mp3',
        }),
      });
      if (!res.ok) await failure(res);
      return { bytes: new Uint8Array(await res.arrayBuffer()), ext: audioExt(res.headers.get('content-type')) };
    }
    case 'elevenlabs': {
      const res = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': s.apiKey, Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: s.model?.trim() || 'eleven_multilingual_v2' }),
      });
      if (!res.ok) await failure(res);
      return { bytes: new Uint8Array(await res.arrayBuffer()), ext: 'mp3' };
    }
  }
}
