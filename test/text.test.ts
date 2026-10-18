import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessLanguage, splitSentences, toParagraphs } from '../src/lib/text.ts';

test('splits Turkish sentences and keeps abbreviations and decimals intact', () => {
  assert.deepEqual(splitSentences('Dr. Ahmet Bey 3.5 kilometre yürüdü! Gerçekten mi? Evet… öyle.'), [
    'Dr. Ahmet Bey 3.5 kilometre yürüdü!',
    'Gerçekten mi?',
    'Evet…',
    'öyle.',
  ]);
});

test('keeps closing quotes with their sentence', () => {
  assert.deepEqual(splitSentences('“Gel.” dedi. Gitti.'), ['“Gel.”', 'dedi.', 'Gitti.']);
});

test('breaks very long sentences at commas so TTS gets manageable chunks', () => {
  const long = Array.from({ length: 60 }, (_, i) => `kelime${i} kelime, `).join('') + 'son.';
  const parts = splitSentences(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 400));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim().replace(/\s+/g, ' '));
});

test('numbers sentences continuously across paragraphs', () => {
  const ps = toParagraphs('Bir. İki.\n\nÜç.');
  assert.deepEqual(ps.map((p) => p.firstSentence), [0, 2]);
});

test('guesses language from metadata first, then from text', () => {
  assert.equal(guessLanguage('the and of', 'tr-TR'), 'tr');
  assert.equal(guessLanguage('Bu bir kitap ve çok güzel, ağaçlar yeşil.'), 'tr');
  assert.equal(guessLanguage('This is the book and it was in the house.'), 'en');
});
