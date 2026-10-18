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
