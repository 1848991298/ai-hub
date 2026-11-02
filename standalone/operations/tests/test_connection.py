import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('operations_server', ROOT / 'server.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)
OperationsBridge = server_module.OperationsBridge
MarketError = server_module.MarketError


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bridge = OperationsBridge(self.root)

    def test_local_shared_local_preserves_data_without_copying(self):
        self.assertEqual(self.bridge.public_config()['mode'], 'local')
        self.bridge.call('snapshot')
        database = self.root / '.local/market.sqlite'
        before = database.read_bytes()
        value = self.bridge.set_config({'mode': 'shared', 'url': 'https://ops.example.com', 'username': 'screen', 'password': 'fixture-private'})
        self.assertNotIn('password', value)
        self.assertNotIn('fixture-private', json.dumps(value))
        self.assertEqual(self.bridge.remote()['password'], 'fixture-private')
        self.assertEqual(self.bridge.config_path.stat().st_mode & 0o777, 0o600)
        self.bridge.set_config({'mode': 'local'})
        self.assertIsNone(self.bridge.remote())
        self.assertEqual(database.read_bytes(), before)
        self.bridge.set_config({'mode': 'shared'})
        self.assertEqual(self.bridge.remote()['password'], 'fixture-private')

    def test_reject_invalid_urls_and_never_reuse_password_for_other_server(self):
        for url in ('http://external.example.com', 'https://user:secret@example.com', 'https://ops.example.com/path', 'file:///tmp'):
            with self.assertRaises(MarketError):
                self.bridge.set_config({'mode': 'shared', 'url': url, 'username': 'screen', 'password': 'fixture'})
        self.bridge.set_config({'mode': 'shared', 'url': 'https://one.example.com', 'username': 'screen', 'password': 'fixture'})
        with self.assertRaises(MarketError):
            self.bridge.set_config({'mode': 'shared', 'url': 'https://two.example.com', 'username': 'screen'})
        self.assertEqual(self.bridge.remote()['url'], 'https://one.example.com')

    def test_unreachable_shared_does_not_return_local_snapshot(self):
        self.bridge.call('snapshot')
        self.bridge.set_config({'mode': 'shared', 'url': 'http://127.0.0.1:1', 'username': 'screen', 'password': 'fixture'})
        with self.assertRaises(MarketError):
            self.bridge.call('snapshot')
        self.assertEqual(self.bridge.public_config()['mode'], 'shared')

    def test_source_app_cannot_read_hub_endpoints_or_credentials(self):
        assets = self.root / 'assets-root'
        assets.mkdir()
        (assets / 'index.html').write_text('fixture')
        self.bridge.set_config({'mode': 'shared', 'url': 'https://ops.example.com', 'username': 'screen', 'password': 'fixture-private'})
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), partial(server_module.Handler, directory=str(assets)))
        httpd.market = self.bridge
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        base = f'http://127.0.0.1:{httpd.server_port}'
        value = json.load(urlopen(base + '/api/connection'))
        self.assertNotIn('fixture-private', json.dumps(value))
        for path in ('/api/rules', '/api/projects', '/.local/connection.json', '/assets/%2e%2e/server.py'):
            with self.assertRaises(HTTPError) as cm:
                urlopen(base + path)
            self.assertEqual(cm.exception.code, 404)
        req = Request(base + '/api/connection', data=b'{"mode":"local"}', headers={'Content-Type': 'application/json', 'Origin': 'https://external.example.com'})
        with self.assertRaises(HTTPError) as cm:
            urlopen(req)
        self.assertEqual(cm.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
