"""图片附件校验与模型协议：本机图片和假 API，不调用外部服务。"""
import base64
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from easyread import chat, chat_images, chat_store
from easyread.store import Workspace


def picture(fmt='PNG'):
    out = io.BytesIO()
    Image.new('RGB', (24, 16), (30, 160, 240)).save(out, format=fmt)
    return out.getvalue()


class ChatImagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ws = Workspace(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_original_bytes_metadata_and_dedup(self):
        for fmt, mime, ext in [('PNG', 'image/png', 'png'), ('JPEG', 'image/jpeg', 'jpg'), ('WEBP', 'image/webp', 'webp')]:
            data = picture(fmt)
            meta = chat_images.save(self.ws, data, '../../截图.' + ext)
            self.assertEqual((meta['mime'], meta['width'], meta['height'], meta['name']), (mime, 24, 16, '截图.' + ext))
            items, paths = chat_images.resolve(self.ws, [meta])
            self.assertEqual(items, [meta])
            self.assertEqual(paths[0].read_bytes(), data)
            self.assertEqual(chat_images.save(self.ws, data)['id'], meta['id'])
        self.assertEqual(len(list((self.root / 'chat-images').iterdir())), 3)

    def test_invalid_format_size_identifier_and_missing_image(self):
        for data in [b'<script>image</script>', picture('GIF'), b'']:
            with self.assertRaises(ValueError):
                chat_images.save(self.ws, data)
        with patch.object(chat_images, 'MAX_BYTES', 10), self.assertRaises(ValueError):
            chat_images.save(self.ws, picture())
        for attachments in [[{'id': '../paper.json'}], [{'id': '0' * 64 + '.png'}], [None], {}, [None] * 5]:
            with self.assertRaises(ValueError):
                chat_images.resolve(self.ws, attachments)

    def test_hash_and_symlink_integrity(self):
        meta = chat_images.save(self.ws, picture())
        target = self.root / 'chat-images' / meta['id']
        target.write_bytes(picture('JPEG'))
        with self.assertRaisesRegex(ValueError, '校验'):
            chat_images.resolve(self.ws, [meta])
        target.unlink()
        target.symlink_to(self.root / 'outside.png')
        with self.assertRaises(ValueError):
            chat_images.resolve(self.ws, [meta])
        with self.assertRaises(ValueError):
            chat_images.save(self.ws, picture())

    def test_saved_history_keeps_image_metadata(self):
        meta = chat_images.save(self.ws, picture())
        chat_store.append(self.ws, 't-images', {'content': '解释截图', 'images': [meta]}, '答案', 'gpt', 'GPT')
        user = chat_store.threads(self.ws)[0]['messages'][0]
        self.assertEqual(user['images'], [meta])
        self.assertNotIn('base64', json.dumps(user))

    def test_openai_image_content_preserves_jpeg_mime_and_bytes(self):
        meta = chat_images.save(self.ws, picture('JPEG'))
        _, paths = chat_images.resolve(self.ws, [meta])
        received = []
        class API(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
        server = ThreadingHTTPServer(('127.0.0.1', 0), API)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            cfg = {'engine': 'openai', 'openai': {'base_url': f'http://127.0.0.1:{server.server_port}', 'model': 'fixture'}}
            self.assertEqual(''.join(chat.stream(cfg, '解释图片', self.root, threading.Event(), images=paths)), 'ok')
        finally:
            server.shutdown()
            server.server_close()
        content = received[0]['messages'][0]['content']
        self.assertEqual(content[0], {'type': 'text', 'text': '解释图片'})
        self.assertEqual(content[1]['image_url']['url'], 'data:image/jpeg;base64,' + base64.b64encode(paths[0].read_bytes()).decode())


if __name__ == '__main__':
    unittest.main()
