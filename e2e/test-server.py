"""Server for the E2E runs: serves the test books in e2e/fixtures and stands in for an OpenAI-compatible
text-to-speech service (POST /v1/audio/speech returns a WAV tone as long as the sentence would take to say).
Usage: python3 e2e/test-server.py [port]"""
import io
import json
import math
import os
import struct
import sys
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
VOICES = ['e2e-ses']


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

    def do_GET(self):
        if self.path.startswith('/v1/audio/voices'):
            return self.send_body(200, json.dumps({'voices': VOICES}).encode(), 'application/json')
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
