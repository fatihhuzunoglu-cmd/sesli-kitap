const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  if (i < len) {
    const rest = len - i;
    const n = (bytes[i] << 16) | (rest > 1 ? bytes[i + 1] << 8 : 0);
    chunk += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    chunk += rest > 1 ? ALPHABET[(n >> 6) & 63] + '=' : '==';
  }
  parts.push(chunk);
  return parts.join('');
}
