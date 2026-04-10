#!/usr/bin/env python3
"""Simple HTTP server for the JX3 Map Viewer."""

import http.server
import json
import os
import sys
from pathlib import Path

PORT = 3015
PUBLIC_DIR = Path(__file__).parent / 'public'
VERDICTS_FILE = PUBLIC_DIR / 'map-data' / 'verdicts.json'

class MapViewerHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/verdicts':
            self._serve_verdicts()
        elif self.path == '/api/meshes':
            self._serve_meshes()
        elif self.path == '/api/open-meshes-folder':
            self._open_meshes_folder()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/verdicts':
            self._save_verdicts()
        else:
            self.send_response(404)
            self.end_headers()

    def _serve_verdicts(self):
        if VERDICTS_FILE.exists():
            data = VERDICTS_FILE.read_bytes()
        else:
            data = b'{"approved":[],"denied":[]}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _save_verdicts(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        try:
            obj = json.loads(body)
            # Normalise: keep only approved/denied arrays
            out = {'approved': list(obj.get('approved', [])),
                   'denied':   list(obj.get('denied', []))}
            VERDICTS_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(f'{{"error":"{e}"}}'.encode())

    def _serve_meshes(self):
        """Return a sorted list of GLB filenames that actually exist in map-data/meshes/.
        Excludes comparison variant files (source__, cache__, official__, lod1__, recomp__)."""
        meshes_dir = PUBLIC_DIR / 'map-data' / 'meshes'
        if meshes_dir.exists():
            names = sorted(f for f in os.listdir(meshes_dir)
                          if f.endswith('.glb')
                          and not f.startswith(('source__', 'cache__', 'official__', 'lod1__', 'recomp__')))
        else:
            names = []
        data = json.dumps(names, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _open_meshes_folder(self):
        """Open the meshes folder in the system file explorer."""
        meshes_dir = PUBLIC_DIR / 'map-data' / 'meshes'
        if meshes_dir.exists():
            os.startfile(str(meshes_dir))
            resp = b'{"ok":true}'
        else:
            resp = b'{"ok":false,"error":"meshes folder not found"}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        mime_map = {
            '.glb': 'model/gltf-binary',
            '.gltf': 'model/gltf+json',
            '.bin': 'application/octet-stream',
            '.dds': 'application/octet-stream',
        }
        return mime_map.get(ext, super().guess_type(path))

    def log_message(self, fmt, *args):
        # Suppress noisy access log; only show errors
        if args and str(args[1]) not in ('200', '304'):
            super().log_message(fmt, *args)

if __name__ == '__main__':
    print(f'Serving {PUBLIC_DIR} on http://localhost:{PORT}')
    server = http.server.HTTPServer(('', PORT), MapViewerHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.shutdown()

