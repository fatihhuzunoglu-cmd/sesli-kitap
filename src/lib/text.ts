export type Paragraph = { sentences: string[]; firstSentence: number };

const ABBREVIATIONS = /(?:\b(?:Dr|Prof|Doç|Av|Yrd|Sn|Bkz|vb|vs|örn|Mr|Mrs|Ms|St|Jr|Sr|No|Vol|vol|pp|etc|e\.g|i\.e|cf)|\b[A-ZÇĞİÖŞÜ])\.$/;
const MAX_SENTENCE = 400;

function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' – '), window.lastIndexOf(' - '));
    if (cut < MAX_SENTENCE / 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_SENTENCE;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function splitSentences(paragraph: string): string[] {
  const pieces: string[] = [];
  const boundary = /[.!?…]+["'”’»)\]]*\s+/g;
  let start = 0;
  for (let m = boundary.exec(paragraph); m; m = boundary.exec(paragraph)) {
    pieces.push(paragraph.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  pieces.push(paragraph.slice(start));

  const merged: string[] = [];
  for (const piece of pieces) {
    const s = piece.trim();
    if (!s) continue;
    const prev = merged[merged.length - 1];
    if (prev && ABBREVIATIONS.test(prev)) merged[merged.length - 1] = `${prev} ${s}`;
    else merged.push(s);
  }
  return merged.flatMap(splitLong);
}

export function toParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let count = 0;
  for (const line of text.split('\n')) {
    const sentences = splitSentences(line);
    if (!sentences.length) continue;
    paragraphs.push({ sentences, firstSentence: count });
    count += sentences.length;
  }
  return paragraphs;
}

const SPEECH_LOCALES: Record<string, string> = {
  tr: 'tr-TR', en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', ru: 'ru-RU', ar: 'ar-SA',
};

// iOS resolves voices from full locales ("tr-TR"); a bare "tr" can silently fall back to another voice.
export function speechLocale(code: string): string {
  return SPEECH_LOCALES[code] ?? code;
}

const TURKISH_CHARS = /[ğışĞİŞ]/g;
const TURKISH_WORDS = /\b(ve|bir|bu|da|de|için|ile|çok|ama|gibi|olarak|daha|ne|kadar)\b/gi;
const ENGLISH_WORDS = /\b(the|and|of|to|is|in|that|it|was|for|with|as|his|her)\b/gi;

export function guessLanguage(sample: string, metadataLanguage?: string | null): string {
  if (metadataLanguage) {
    const code = metadataLanguage.trim().toLowerCase().split(/[-_]/)[0];
    if (/^[a-z]{2,3}$/.test(code)) return code;
  }
  const tr = (sample.match(TURKISH_CHARS)?.length ?? 0) * 2 + (sample.match(TURKISH_WORDS)?.length ?? 0);
  const en = sample.match(ENGLISH_WORDS)?.length ?? 0;
  return tr >= en ? 'tr' : 'en';
}

export type Pronunciation = { from: string; to: string };

const WORD = /[0-9A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛûÄäËëÏïÜüÉéÈèÀàÑñßÆæØøÅå'’-]+/g;

function foldCase(s: string) {
  return s.toLocaleLowerCase('tr');
}

// Replaces whole words (case-insensitively, Turkish casing) so the voice says them the way the reader wants.
export function applyPronunciations(text: string, list: Pronunciation[]): string {
  if (!list.length) return text;
  const single = new Map<string, string>();
  const phrases: Pronunciation[] = [];
  for (const p of list) {
    const from = p.from.trim();
    if (!from) continue;
    if (from.replace(WORD, '') !== '') phrases.push({ from, to: p.to });
    else single.set(foldCase(from), p.to);
  }
  let out = text;
  for (const p of phrases) {
    const escaped = p.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    out = out.replace(new RegExp(escaped, 'gi'), p.to);
  }
  if (single.size) out = out.replace(WORD, (w) => single.get(foldCase(w)) ?? w);
  return out;
}
