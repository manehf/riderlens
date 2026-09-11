#!/usr/bin/env python3
"""Local, owned-endpoint fault fixture. Never forwards or runs an analysis."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from email.message import Message
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import math
import mmap
import os
from pathlib import Path
import re
import socket
import sqlite3
import ssl
import tempfile
import time
from urllib.parse import unquote, urlsplit


class InvalidUpload(ValueError):
    pass


def fingerprint_upload(path: Path, content_type: str) -> tuple[str, str, str]:
    """Scan the disk spool; never materialize video bytes or the entire multipart."""
    mime = Message()
    mime['content-type'] = content_type
    boundary = mime.get_param('boundary')
    if mime.get_content_type() != 'multipart/form-data' or not boundary:
        raise InvalidUpload('Expected multipart/form-data with a boundary.')
    try:
        boundary_bytes = boundary.encode('ascii')
    except UnicodeEncodeError:
        raise InvalidUpload('Invalid boundary.') from None
    if not 1 <= len(boundary_bytes) <= 200 or b'\r' in boundary_bytes or b'\n' in boundary_bytes:
        raise InvalidUpload('Invalid boundary.')
    fields = {}
    video_hash = None
    delimiter = b'\r\n--' + boundary_bytes
    with path.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as body:
        opening = b'--' + boundary_bytes + b'\r\n'
        if body[:len(opening)] != opening:
            raise InvalidUpload('Invalid multipart opening.')
        cursor = len(opening)
        for _ in range(16):
            header_end = body.find(b'\r\n\r\n', cursor, min(len(body), cursor + 8192))
            if header_end < 0:
                raise InvalidUpload('Invalid multipart headers.')
            headers = Message()
            for line in body[cursor:header_end].decode('latin1').split('\r\n'):
                if ':' not in line:
                    raise InvalidUpload('Invalid multipart header.')
                key, value = line.split(':', 1)
                headers[key] = value.strip()
            name = headers.get_param('name', header='content-disposition')
            start = header_end + 4
            end = body.find(delimiter, start)
            while end >= 0 and body[end + len(delimiter):end + len(delimiter) + 2] not in (b'\r\n', b'--'):
                end = body.find(delimiter, end + 1)
            if end < 0 or not name:
                raise InvalidUpload('Incomplete multipart part.')
            if name == 'video':
                if video_hash is not None or start == end:
                    raise InvalidUpload('Provide exactly one nonempty video.')
                digest = hashlib.sha256()
                for position in range(start, end, 65536):
                    digest.update(body[position:min(end, position + 65536)])
                video_hash = digest.hexdigest()
            else:
                if name in fields or end - start > 65536:
                    raise InvalidUpload('Duplicate or oversized form field.')
                fields[name] = body[start:end].decode('utf-8')
            suffix = end + len(delimiter)
            if body[suffix:suffix + 2] == b'--':
                if len(body) - suffix - 2 > 2 or body[suffix + 2:] not in (b'', b'\r\n'):
                    raise InvalidUpload('Invalid multipart ending.')
                break
            cursor = suffix + 2
        else:
            raise InvalidUpload('Too many multipart fields.')
    request_id = fields.get('request_id', '')
    if not re.fullmatch(r'[A-Za-z0-9._-]{8,160}', request_id):
        raise InvalidUpload('Invalid request_id.')
    if not video_hash or 'upload_id' in fields:
        raise InvalidUpload('This fixture requires a video file, not upload_id.')
    if set(fields) - {'request_id', 'start_seconds', 'end_seconds', 'events_json', 'rotate_degrees'}:
        raise InvalidUpload('Unsupported form field.')
    try:
        start = float(fields['start_seconds'])
        end = float(fields['end_seconds'])
        rotate = int(fields.get('rotate_degrees', '0'))
        events = json.loads(fields.get('events_json', '[]'))
        if not all(map(math.isfinite, (start, end))) or not 0 <= start < end <= start + 8:
            raise ValueError()
        if rotate not in (0, 90, 180, 270) or not isinstance(events, list) or not all(isinstance(event, dict) for event in events):
            raise ValueError()
        canonical = json.dumps([start, end, rotate, events], sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (KeyError, ValueError, TypeError):
        raise InvalidUpload('Invalid analysis parameters.') from None
    fingerprint = hashlib.sha256((video_hash + '\n' + canonical).encode()).hexdigest()
    return request_id, video_hash, fingerprint


class FixtureState:
    def __init__(self, directory: Path):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.database = directory / 'jobs.sqlite3'
        with self.connect() as connection:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('CREATE TABLE IF NOT EXISTS jobs (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, video_sha256 TEXT NOT NULL, body_sha256 TEXT NOT NULL, accepted_count INTEGER NOT NULL, post_count INTEGER NOT NULL, accepted_at REAL NOT NULL)')
            connection.execute('CREATE TABLE IF NOT EXISTS flags (name TEXT PRIMARY KEY)')

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database, timeout=10)
        connection.execute('PRAGMA synchronous=FULL')
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def accept(self, request_id, fingerprint, video_hash, body_hash, drop_ack):
        with self.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            existing = connection.execute('SELECT fingerprint FROM jobs WHERE request_id=?', (request_id,)).fetchone()
            if existing and existing[0] != fingerprint:
                return False, False
            if existing:
                connection.execute('UPDATE jobs SET post_count=post_count+1 WHERE request_id=?', (request_id,))
            else:
                connection.execute('INSERT INTO jobs VALUES (?,?,?,?,1,1,?)', (request_id, fingerprint, video_hash, body_hash, time.time()))
            should_drop = bool(drop_ack and not connection.execute("SELECT 1 FROM flags WHERE name='ack_dropped'").fetchone())
            if should_drop:
                connection.execute("INSERT INTO flags VALUES ('ack_dropped')")
        return True, should_drop  # Transaction committed before dropping the connection.

    def exists(self, request_id):
        with self.connect() as connection:
            return bool(connection.execute('SELECT 1 FROM jobs WHERE request_id=?', (request_id,)).fetchone())


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, _format, *_args):
        pass  # Avoid logging IDs, query strings, headers or upload content.

    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def reply(self, status, value):
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass

    def authorized(self):
        if not hmac.compare_digest(self.headers.get('x-riderlens-key', ''), self.server.worker_key):
            self.reply(401, {'detail': 'Invalid fixture key.'})
            return False
        return True

    @staticmethod
    def job(request_id):
        return {'jobId': request_id, 'status': 'queued', 'retryAfterSeconds': 10, 'error': None, 'retryable': True}

    def do_GET(self):
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        if path == '/health':
            self.reply(200, {'status': 'ok', 'captureJobsEnabled': True, 'fixture': True})
        elif path.startswith('/capture/jobs/'):
            request_id = unquote(path.removeprefix('/capture/jobs/'))
            self.reply(200, self.job(request_id)) if self.server.state.exists(request_id) else self.reply(404, {'detail': 'Job not found.'})
        else:
            self.reply(404, {'detail': 'This fixture does not generate analysis results.'})

    def do_POST(self):
        if not self.authorized():
            return
        if urlsplit(self.path).path != '/capture/jobs':
            self.reply(404, {'detail': 'Only capture job submission is supported.'})
            return
        if self.headers.get('Transfer-Encoding'):
            self.reply(411, {'detail': 'A file upload with Content-Length is required.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= self.server.max_body_bytes:
            self.reply(413, {'detail': 'Empty or oversized upload.'})
            return
        try:
            with tempfile.NamedTemporaryFile(prefix='riderlens-fixture-', suffix='.multipart') as spool:
                digest = hashlib.sha256()
                remaining = length
                started = time.monotonic()
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise InvalidUpload('Upload connection ended early.')
                    spool.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                    if self.server.throttle:
                        wait = (length - remaining) / self.server.throttle - (time.monotonic() - started)
                        if wait > 0:
                            time.sleep(wait)
                spool.flush()
                request_id, video_hash, fingerprint = fingerprint_upload(Path(spool.name), self.headers.get('Content-Type', ''))
                accepted, drop = self.server.state.accept(request_id, fingerprint, video_hash, digest.hexdigest(), self.server.drop_ack)
            if not accepted:
                self.reply(409, {'detail': 'Request ID already belongs to different input.'})
                return
            print(json.dumps({'event': 'accepted', 'request_hash': hashlib.sha256(request_id.encode()).hexdigest()[:16], 'drop_ack': drop}), flush=True)
            if drop:
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.connection.close()
                return
            if self.server.response_delay:
                time.sleep(self.server.response_delay)
            self.reply(202, self.job(request_id))
        except (InvalidUpload, UnicodeError) as error:
            self.reply(400, {'detail': str(error)})
        except (OSError, sqlite3.Error):
            self.reply(503, {'detail': 'Fixture storage or connection failed.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--cert', type=Path)
    parser.add_argument('--key', type=Path)
    parser.add_argument('--allow-http', action='store_true', help='Explicit loopback-only smoke test; never for device validation.')
    parser.add_argument('--state-dir', type=Path, help='Defaults to a newly-created private temporary directory.')
    parser.add_argument('--upload-bytes-per-second', type=int, default=0, help='0 disables throttling.')
    parser.add_argument('--response-delay', type=float, default=0)
    parser.add_argument('--drop-ack', action='store_true', help='Drop the first accepted acknowledgement once per state directory.')
    parser.add_argument('--max-body-bytes', type=int, default=100 * 1024 * 1024)
    args = parser.parse_args()
    if args.allow_http:
        if args.host not in ('127.0.0.1', 'localhost') or args.cert or args.key:
            parser.error('--allow-http requires loopback and no TLS arguments.')
    elif not args.cert or not args.key:
        parser.error('HTTPS requires --cert and --key; local smoke tests may explicitly use --allow-http.')
    if args.upload_bytes_per_second < 0 or not math.isfinite(args.response_delay) or args.response_delay < 0 or args.max_body_bytes <= 0:
        parser.error('Invalid throttle, delay or body limit.')
    worker_key = os.environ.get('RIDERLENS_FIXTURE_KEY', '')
    if not worker_key:
        parser.error('Set RIDERLENS_FIXTURE_KEY to a dedicated test key; never use the production key.')
    os.umask(0o077)
    directory = args.state_dir or Path(tempfile.mkdtemp(prefix='riderlens-transfer-fixture-'))
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.state = FixtureState(directory)
    server.worker_key = worker_key
    server.throttle = args.upload_bytes_per_second
    server.response_delay = args.response_delay
    server.drop_ack = args.drop_ack
    server.max_body_bytes = args.max_body_bytes
    if not args.allow_http:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f'Fixture listening on {args.host}:{args.port}; private state: {directory}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
