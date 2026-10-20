// Characters handed to the native translator per call; keeps each call short enough to stay responsive.
const BATCH_CHARS = 3000;

// Next untranslated section from the focus onwards, then any earlier one.
export function nextIndex(count: number, done: Set<number>, focus: number): number | null {
  for (let i = Math.max(0, focus); i < count; i++) if (!done.has(i)) return i;
  for (let i = 0; i < Math.min(focus, count); i++) if (!done.has(i)) return i;
  return null;
}

// Groups paragraphs so each native call gets a few thousand characters.
export function batches(texts: string[], maxChars = BATCH_CHARS): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const t of texts) {
    if (cur.length && size + t.length > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += t.length;
  }
  if (cur.length) out.push(cur);
  return out;
}
