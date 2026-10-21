import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioExt, cloudVoiceRef, listCloudVoices, parseCloudVoice, synthesizeCloud } from '../src/tts/cloudVoices.ts';

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('cloud voice references round-trip, including ids with colons', () => {
  const ref = cloudVoiceRef('custom', 'speaker:7');
  assert.deepEqual(parseCloudVoice(ref), { provider: 'custom', voiceId: 'speaker:7' });
  assert.equal(parseCloudVoice('com.apple.voice.Yelda'), null);
  assert.equal(parseCloudVoice(null), null);
});

test('Google voices are filtered to the language and sorted best first', async () => {
  const { fn, calls } = fakeFetch(() =>
    Response.json({
      voices: [
        { name: 'tr-TR-Standard-A', ssmlGender: 'FEMALE', languageCodes: ['tr-TR'] },
        { name: 'tr-TR-Chirp3-HD-Achernar', ssmlGender: 'FEMALE', languageCodes: ['tr-TR'] },
        { name: 'tr-TR-Wavenet-B', ssmlGender: 'MALE', languageCodes: ['tr-TR'] },
        { name: 'en-US-Neural2-A', ssmlGender: 'MALE', languageCodes: ['en-US'] },
      ],
    }),
  );
  const voices = await listCloudVoices({ provider: 'google', apiKey: 'k' }, 'tr', fn);
  assert.deepEqual(voices.map((v) => v.id), ['tr-TR-Chirp3-HD-Achernar', 'tr-TR-Wavenet-B', 'tr-TR-Standard-A']);
  assert.match(voices[0].detail, /Chirp3-HD · Kadın/);
  assert.match(calls[0].url, /languageCode=tr&key=k/);
});

test('Google speech is requested as MP3 for the locale and decoded from base64', async () => {
  const { fn, calls } = fakeFetch(() => Response.json({ audioContent: Buffer.from('ID3-audio').toString('base64') }));
  const audio = await synthesizeCloud({ provider: 'google', apiKey: 'k' }, 'tr-TR-Chirp3-HD-Achernar', 'Merhaba.', 'tr-TR', fn);
  assert.equal(audio.ext, 'mp3');
  assert.equal(Buffer.from(audio.bytes).toString(), 'ID3-audio');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body.voice, { languageCode: 'tr-TR', name: 'tr-TR-Chirp3-HD-Achernar' });
  assert.equal(body.audioConfig.audioEncoding, 'MP3');
});

test('an OpenAI-compatible server gets /v1/audio/speech, the key and the default model; WAV replies keep their type', async () => {
  const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/wav' } }));
  const audio = await synthesizeCloud({ provider: 'custom', apiKey: 'secret', baseUrl: 'http://10.0.2.2:8001/' }, 'alloy', 'Merhaba.', 'tr-TR', fn);
  assert.equal(calls[0].url, 'http://10.0.2.2:8001/v1/audio/speech');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { model: 'tts-1', voice: 'alloy', input: 'Merhaba.', response_format: 'mp3' });
  assert.equal(audio.ext, 'wav');
});

test('errors say what went wrong in Turkish', async () => {
  const unauthorized = fakeFetch(() => Response.json({ error: { message: 'bad key' } }, { status: 401 }));
  await assert.rejects(synthesizeCloud({ provider: 'openai', apiKey: 'x' }, 'nova', 'a', 'tr-TR', unauthorized.fn), /API anahtarı geçersiz/);
  const limited = fakeFetch(() => new Response('', { status: 429 }));
  await assert.rejects(synthesizeCloud({ provider: 'elevenlabs', apiKey: 'x' }, 'v', 'a', 'tr-TR', limited.fn), /kullanım sınırına/);
  await assert.rejects(synthesizeCloud({ provider: 'custom', apiKey: '', baseUrl: 'sunucum' }, 'v', 'a', 'tr-TR', limited.fn), /http/);
});

test('audio types are read from the content type', () => {
  assert.equal(audioExt('audio/mpeg'), 'mp3');
  assert.equal(audioExt('audio/x-wav'), 'wav');
  assert.equal(audioExt(null), 'mp3');
});
