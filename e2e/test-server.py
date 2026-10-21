"""Server for the E2E runs: serves the test books in e2e/fixtures and stands in for
 - an OpenAI-compatible text-to-speech service (POST /v1/audio/speech returns a WAV tone as long as the sentence would take to say);
 - the Internet Archive (/mock-archive: one two-chapter LibriVox audiobook) and Gutendex (/mock-gutendex: one e-book).
Usage: python3 e2e/test-server.py [port]"""
import io
import json
import math
import os
import re
import struct
import sys
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
VOICES = ['e2e-ses']
AUDIOBOOK = 'e2e_masallar_librivox'
CHAPTERS = [('bolum_1', 'Birinci masal'), ('bolum_2', 'İkinci masal')]


def tone(seconds, rate=22050):
    frames = b''.join(
        struct.pack('<h', int(2500 * math.sin(2 * math.pi * 330 * i / rate))) for i in range(int(seconds * rate))
    )
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FIXTURES, **kwargs)

    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, body):
        return self.send_body(200, json.dumps(body).encode(), 'application/json')

    # Audio players stream with byte ranges (iOS insists on them).
    def send_audio(self, path):
        with open(path, 'rb') as f:
            data = f.read()
        m = re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range') or '')
        if m and (m.group(1) or m.group(2)):
            start = int(m.group(1)) if m.group(1) else len(data) - int(m.group(2))
            end = min(len(data) - 1, int(m.group(2))) if m.group(1) and m.group(2) else len(data) - 1
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
            data = data[start:end + 1]
        else:
            self.send_response(200)
        self.send_header('Content-Type', 'audio/mpeg')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def mock_catalog(self):
        path, _, query = self.path.partition('?')
        if path == '/mock-archive/advancedsearch.php':
            print(f'catalog search: {query[:120]}', flush=True)
            librivox = 'librivoxaudio' in query and 'mediatype' not in query
            docs = [{'identifier': AUDIOBOOK, 'title': 'Deneme Masalları', 'creator': 'E2E Okuyucu', 'language': 'tur', 'runtime': '0:00:40'}] if librivox else []
            return self.send_json({'response': {'numFound': len(docs), 'docs': docs}})
        if path == f'/mock-archive/metadata/{AUDIOBOOK}':
            files = []
            for i, (name, title) in enumerate(CHAPTERS):
                files.append({'name': f'{name}.mp3', 'format': 'VBR MP3', 'title': title, 'track': f'{i + 1}/{len(CHAPTERS)}', 'length': '20.0'})
                files.append({'name': f'{name}_64kb.mp3', 'format': '64Kbps MP3', 'title': title, 'length': '0:20'})
            return self.send_json({'metadata': {'title': 'Deneme Masalları', 'creator': 'E2E Okuyucu', 'language': 'tur'}, 'files': files})
        if path.startswith(f'/mock-archive/download/{AUDIOBOOK}/'):
            print(f'audio download: {path}', flush=True)
            return self.send_audio(os.path.join(FIXTURES, 'ses-bolum.mp3'))
        if path.startswith('/mock-gutendex/books'):
            host = self.headers.get('Host')
            return self.send_json({'results': [{
                'id': 9001, 'title': 'The Lighthouse Keeper', 'authors': [{'name': 'Kitap, Deneme'}], 'languages': ['en'],
                'copyright': False, 'formats': {'application/epub+zip': f'http://{host}/lighthouse.epub'},
            }]})
        return self.send_body(404, b'{}', 'application/json')

    def do_HEAD(self):
        if self.path.startswith('/mock-'):
            return self.mock_catalog()
        return super().do_HEAD()

    def do_GET(self):
        if self.path.startswith('/v1/audio/voices'):
            return self.send_json({'voices': VOICES})
        if self.path.startswith('/mock-'):
            return self.mock_catalog()
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            body = {}
        if self.path != '/v1/audio/speech':
            return self.send_body(404, b'{}', 'application/json')
        if body.get('voice') not in VOICES or not body.get('input'):
            return self.send_body(400, json.dumps({'error': {'message': 'unknown voice'}}).encode(), 'application/json')
        print(f"tts: {body.get('voice')} {body.get('model')} {body['input'][:60]!r}", flush=True)
        self.send_body(200, tone(min(4.0, 0.5 + 0.05 * len(body['input']))), 'audio/wav')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
