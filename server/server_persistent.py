import os
import sys
import secrets
import json
import asyncio
import logging
import zipfile
import subprocess
import requests
import aiohttp
from aiohttp import web, WSMsgType
from stem.control import Controller
from stem import SocketError
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
import tempfile
import time
from pathlib import Path
import sqlite3
import mimetypes

# ========== BUILD DIR ==========
if getattr(sys, 'frozen', False):
    BUILD_DIR = os.path.normpath(
        os.path.join(os.path.dirname(sys.executable), '..', 'server', 'build')
    )
else:
    BUILD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build')

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

IPFS_API = "http://127.0.0.1:5001/api/v0"

# ========== IPFS ==========
MAX_RETRIES = 30
WAIT_SECONDS = 1

for attempt in range(MAX_RETRIES):
    try:
        r = requests.post(f"{IPFS_API}/version", timeout=2)
        r.raise_for_status()
        print(f"Connected to IPFS: {r.json()}", flush=True)
        break
    except Exception as e:
        print(f"IPFS not ready, retrying... ({attempt+1}/{MAX_RETRIES}): {e}", flush=True)
        time.sleep(WAIT_SECONDS)
else:
    raise Exception("Failed to connect to IPFS after several retries")


def ipfs_add_stream(file_path):
    with open(file_path, "rb") as f:
        response = requests.post(
            f"{IPFS_API}/add",
            files={"file": f},
            stream=True
        )
        response.raise_for_status()
        last = None
        for line in response.iter_lines():
            if line:
                last = json.loads(line)
        return last["Hash"]


def ipfs_pin_rm(ipfs_hash):
    try:
        requests.post(f"{IPFS_API}/pin/rm", params={"arg": ipfs_hash}, timeout=10)
    except Exception as e:
        logger.warning(f"Failed to unpin {ipfs_hash}: {e}")


# ========== GLOBALS ==========
tor_service = None
service_id = None
clearnet_url = None

websocket_connections = {}
download_progress = {}
rate_limit_store = {}

CHUNK_SIZE = 65536
DEFAULT_TTL = 24 * 60 * 60

DB_PATH = os.path.join(os.path.expanduser("~"), "AppData", "Local", "FileShare", "metadata.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


# ========== DATABASE ==========
class ShareMetadata:
    def __init__(self, db_path=DB_PATH):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS share_metadata (
                    share_id TEXT PRIMARY KEY,
                    ipfs_hash TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    private_key TEXT NOT NULL,
                    max_downloads INTEGER NOT NULL,
                    download_count INTEGER NOT NULL DEFAULT 0,
                    active INTEGER NOT NULL DEFAULT 1,
                    expires_at REAL NOT NULL,
                    file_size INTEGER NOT NULL DEFAULT 0
                );
            """)
            conn.commit()

    async def create_share(self, ipfs_hash, filename, content_type, private_key,
                           file_size=0, max_downloads=1, expires_at=None, share_id=None):
        share_id = share_id or secrets.token_urlsafe(16)
        expires_at = expires_at or (time.time() + DEFAULT_TTL)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO share_metadata
                (share_id, ipfs_hash, filename, content_type, private_key, max_downloads, expires_at, file_size)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (share_id, ipfs_hash, filename, content_type, private_key, max_downloads, expires_at, file_size))
            conn.commit()
        return share_id

    async def check_download_limits(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT active, download_count, max_downloads, expires_at FROM share_metadata WHERE share_id = ?",
                (share_id,)
            )
            row = cur.fetchone()
            if not row:
                raise ValueError("Invalid share ID")
            active, count, max_dl, expires = row
            if not active:
                raise ValueError("Share link is inactive")
            if count >= max_dl:
                raise ValueError("Maximum downloads exceeded")
            if time.time() > expires:
                raise ValueError("Link has expired")

    def get_metadata(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute("SELECT * FROM share_metadata WHERE share_id = ?", (share_id,))
            row = cur.fetchone()
            if not row:
                return None
            return dict(zip([col[0] for col in cur.description], row))

    def increment_download_count(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT download_count, max_downloads FROM share_metadata WHERE share_id = ?",
                (share_id,)
            )
            row = cur.fetchone()
            if row:
                count, max_dl = row
                new_count = count + 1
                active = 0 if new_count >= max_dl else 1
                conn.execute(
                    "UPDATE share_metadata SET download_count = ?, active = ? WHERE share_id = ?",
                    (new_count, active, share_id)
                )
                conn.commit()

    def stop_share(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute("SELECT ipfs_hash FROM share_metadata WHERE share_id = ?", (share_id,))
            row = cur.fetchone()
            if row:
                conn.execute("UPDATE share_metadata SET active = 0 WHERE share_id = ?", (share_id,))
                conn.commit()
                return row[0]
        return None

    def get_all_expired(self):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT share_id, ipfs_hash FROM share_metadata WHERE expires_at <= ?",
                (time.time(),)
            )
            return cur.fetchall()

    def is_active(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute("SELECT active FROM share_metadata WHERE share_id = ?", (share_id,))
            row = cur.fetchone()
            return bool(row and row[0])


share_metadata = ShareMetadata()


# ========== TOR ==========
def start_tor_service():
    for _ in range(5):
        try:
            with Controller.from_port(port=9051) as controller:
                controller.authenticate()
                hidden_service = controller.create_ephemeral_hidden_service(
                    ports={80: 5000}, await_publication=True, detached=True
                )
                return hidden_service
        except SocketError:
            time.sleep(1)
    raise RuntimeError("Failed to connect to Tor control port after multiple attempts")


# ========== FRONTEND SERVING ==========
async def serve_frontend(request):
    index_path = os.path.join(BUILD_DIR, 'index.html')
    if not os.path.exists(index_path):
        return web.Response(text=f"Frontend not built. Looking in: {BUILD_DIR}", status=503)
    return web.FileResponse(index_path)


async def serve_static(request):
    filename = request.match_info['filename']
    file_path = os.path.join(BUILD_DIR, 'static', filename)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        mime, _ = mimetypes.guess_type(file_path)
        return web.FileResponse(file_path, headers={"Content-Type": mime or "application/octet-stream"})
    return web.Response(status=404)


async def serve_root_file(request):
    filename = request.match_info['filename']
    file_path = os.path.join(BUILD_DIR, filename)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        mime, _ = mimetypes.guess_type(file_path)
        return web.FileResponse(file_path, headers={"Content-Type": mime or "application/octet-stream"})
    return web.Response(status=404)


# ========== CRYPTO HELPERS ==========
def generate_key_pair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


async def encrypt_file_to_temp_async(src_path, public_key, share_id):
    aes_key = os.urandom(32)
    nonce = os.urandom(12)
    cipher = Cipher(algorithms.AES(aes_key), modes.GCM(nonce))
    encryptor = cipher.encryptor()

    encrypted_key = public_key.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".enc")
    tmp_path = tmp.name

    tmp.write(encrypted_key)
    tmp.write(b'\x00' * 16)
    tmp.write(nonce)

    total_size = os.path.getsize(src_path)
    processed = 0
    last_reported = -1

    with open(src_path, "rb") as f:
        while True:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            tmp.write(encryptor.update(chunk))
            processed += len(chunk)
            progress = 10 + int((processed / total_size) * 40)
            if progress != last_reported:
                last_reported = progress
                if share_id in websocket_connections:
                    for ws in websocket_connections[share_id]:
                        try:
                            await ws.send_str(json.dumps({"progress": progress, "status": "encrypting"}))
                        except Exception:
                            pass
            await asyncio.sleep(0)

    final_block = encryptor.finalize()
    if final_block:
        tmp.write(final_block)

    tag = encryptor.tag
    tmp.seek(256)
    tmp.write(tag)
    tmp.close()

    file_size = os.path.getsize(tmp_path)
    return tmp_path, file_size


# ========== DOWNLOAD ==========
async def download_file(request):
    share_id = request.match_info["share_id"]
    try:
        await share_metadata.check_download_limits(share_id)
        metadata = share_metadata.get_metadata(share_id)
        if not metadata:
            return web.json_response({"error": "Invalid or expired link"}, status=404)

        private_key = serialization.load_pem_private_key(
            metadata["private_key"].encode(), password=None
        )

        download_token = secrets.token_urlsafe(8)
        stored_size = metadata.get("file_size", 0)
        decrypted_size = stored_size - 284 if stored_size > 284 else 0

        download_progress[download_token] = {
            "bytes_sent": 0,
            "total_bytes": decrypted_size,
            "speed_mbps": 0.0,
            "percent": 0,
            "done": False,
            "filename": metadata["filename"],
        }

        timeout = aiohttp.ClientTimeout(total=None, sock_connect=60, sock_read=None)

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{IPFS_API}/cat",
                params={"arg": metadata["ipfs_hash"]}
            ) as ipfs_resp:
                ipfs_resp.raise_for_status()

                header = await ipfs_resp.content.readexactly(284)
                encrypted_key = header[:256]
                tag = header[256:272]
                nonce = header[272:284]

                aes_key = private_key.decrypt(
                    encrypted_key,
                    padding.OAEP(
                        mgf=padding.MGF1(algorithm=hashes.SHA256()),
                        algorithm=hashes.SHA256(),
                        label=None,
                    ),
                )

                cipher = Cipher(algorithms.AES(aes_key), modes.GCM(nonce, tag))
                decryptor = cipher.decryptor()

                response = web.StreamResponse(
                    status=200,
                    headers={
                        "Content-Type": metadata["content_type"],
                        "Content-Disposition": f'attachment; filename="{metadata["filename"]}"',
                        "Accept-Ranges": "bytes",
                        "X-Download-Token": download_token,
                        "Access-Control-Expose-Headers": "X-Download-Token",
                        **({"Content-Length": str(decrypted_size)} if decrypted_size else {}),
                    }
                )
                await response.prepare(request)

                bytes_sent = 0
                last_time = time.time()
                last_bytes = 0

                async for chunk in ipfs_resp.content.iter_chunked(CHUNK_SIZE):
                    decrypted = decryptor.update(chunk)
                    if decrypted:
                        await response.write(decrypted)
                        bytes_sent += len(decrypted)
                        now = time.time()
                        elapsed = now - last_time
                        if elapsed >= 0.5:
                            delta_bytes = bytes_sent - last_bytes
                            speed_mbps = round((delta_bytes * 8) / elapsed / 1_000_000, 2)
                            percent = int((bytes_sent / decrypted_size) * 100) if decrypted_size else 0
                            download_progress[download_token].update({
                                "bytes_sent": bytes_sent,
                                "speed_mbps": speed_mbps,
                                "percent": percent,
                                "done": False,
                            })
                            last_time = now
                            last_bytes = bytes_sent

                final = decryptor.finalize()
                if final:
                    await response.write(final)
                    bytes_sent += len(final)

                download_progress[download_token].update({
                    "bytes_sent": bytes_sent,
                    "percent": 100,
                    "speed_mbps": 0.0,
                    "done": True,
                })

                await response.write_eof()
                
                share_metadata.increment_download_count(share_id)

                async def cleanup_token():
                    await asyncio.sleep(60)
                    download_progress.pop(download_token, None)
                asyncio.create_task(cleanup_token())

                return response

    except ValueError as e:
        return web.json_response({"error": str(e)}, status=403)
    except Exception as e:
        logger.error(f"Download error: {e}", exc_info=True)
        return web.json_response({"error": "Internal server error"}, status=500)


async def get_download_progress(request):
    token = request.match_info["token"]
    data = download_progress.get(token)
    if not data:
        return web.json_response({"error": "Invalid or expired token"}, status=404)
    return web.json_response(data)


# ========== UPLOAD ==========
async def upload_file(request):
    try:
        reader = await request.multipart()
        if not reader:
            return web.json_response({"error": "No files uploaded"}, status=400)

        max_downloads = int(request.query.get("max_downloads", 1))
        if max_downloads < 1:
            return web.json_response({"error": "Max downloads must be at least 1"}, status=400)

        private_key, public_key = generate_key_pair()
        share_id = request.query.get("share_id") or secrets.token_urlsafe(16)

        file_parts = []
        async for part in reader:
            if part.name != "files":
                continue
            filename = Path(part.filename).name
            tmp = tempfile.NamedTemporaryFile(delete=False)
            tmp_path = tmp.name
            while True:
                chunk = await part.read_chunk(CHUNK_SIZE)
                if not chunk:
                    break
                tmp.write(chunk)
            tmp.close()
            file_parts.append({
                "filename": filename,
                "temp_path": tmp_path,
                "content_type": part.headers.get("Content-Type", "application/octet-stream"),
            })

        if not file_parts:
            return web.json_response({"error": "No valid files uploaded"}, status=400)

        if len(file_parts) > 1:
            zip_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
            zip_path = zip_tmp.name
            zip_tmp.close()
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
                for f in file_parts:
                    zipf.write(f["temp_path"], arcname=f["filename"])
            filename = request.query.get("zip_name", "bundle.zip")
            if not filename.endswith(".zip"):
                filename += ".zip"
            content_type = "application/zip"
            data_path = zip_path
        else:
            filename = file_parts[0]["filename"]
            content_type = file_parts[0]["content_type"]
            data_path = file_parts[0]["temp_path"]

        async def send_progress(progress, status="uploading"):
            if share_id in websocket_connections:
                for ws in websocket_connections[share_id]:
                    try:
                        await ws.send_str(json.dumps({"progress": progress, "status": status}))
                    except Exception:
                        pass

        await send_progress(10, "encrypting")

        enc_path, enc_size = await encrypt_file_to_temp_async(data_path, public_key, share_id)

        await send_progress(50, "uploading to IPFS")

        async def ipfs_upload_with_progress():
            loop = asyncio.get_event_loop()
            task = loop.run_in_executor(None, ipfs_add_stream, enc_path)
            p = 50
            while not task.done():
                await asyncio.sleep(1)
                if p < 89:
                    p += 1
                    await send_progress(p, "uploading to IPFS")
            return await task

        ipfs_hash = await ipfs_upload_with_progress()

        await send_progress(90, "finalizing")

        await share_metadata.create_share(
            ipfs_hash, filename, content_type,
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            ).decode(),
            file_size=enc_size,
            max_downloads=max_downloads,
            share_id=share_id,
        )

        for f in file_parts:
            os.remove(f["temp_path"])
        if len(file_parts) > 1:
            os.remove(zip_path)
        os.remove(enc_path)

        await send_progress(100, "complete")

        if share_id in websocket_connections:
            for ws in websocket_connections[share_id]:
                try:
                    await ws.close()
                except Exception:
                    pass

        links = [{
            "share_id": share_id,
            "share_link": f"http://{service_id}.onion/#/get/{share_id}",
            "filename": filename,
            "max_downloads": max_downloads,
            "link_type": "tor",
        }]
        if clearnet_url:
            links.append({
                "share_id": share_id,
                "share_link": f"{clearnet_url}/#/get/{share_id}",
                "filename": filename,
                "max_downloads": max_downloads,
                "link_type": "clearnet",
            })

        return web.json_response({"share_links": links})

    except Exception as e:
        logger.error(f"Upload error: {e}", exc_info=True)
        return web.json_response({"error": "Internal server error"}, status=500)


# ========== WEBSOCKET PROGRESS ==========
async def websocket_progress(request):
    share_id = request.match_info["share_id"]
    if not share_id or share_id == "null":
        return web.json_response({"error": "Invalid share ID"}, status=400)

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    websocket_connections.setdefault(share_id, []).append(ws)

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT and msg.data == "close":
                await ws.close()
                break
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        conns = websocket_connections.get(share_id, [])
        if ws in conns:
            conns.remove(ws)
        if not conns:
            websocket_connections.pop(share_id, None)
    return ws


# ========== OTHER ROUTES ==========
async def stop_sharing(request):
    share_id = request.match_info["share_id"]
    ipfs_hash = share_metadata.stop_share(share_id)
    if not ipfs_hash:
        return web.json_response({"error": "Invalid share ID"}, status=404)
    ipfs_pin_rm(ipfs_hash)
    return web.json_response({"status": "stopped", "share_id": share_id})


async def check_status(request):
    share_id = request.match_info["share_id"]
    return web.json_response({"active": share_metadata.is_active(share_id)})


async def get_share_history(request):
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("""
            SELECT share_id, filename, max_downloads, download_count, active, expires_at
            FROM share_metadata ORDER BY expires_at DESC
        """)
        rows = cur.fetchall()

    result = []
    for r in rows:
        entry = {
            "share_id": r[0],
            "filename": r[1],
            "max_downloads": r[2],
            "download_count": r[3],
            "active": bool(r[4]),
            "expires_at": r[5],
            "tor_link": f"http://{service_id}.onion/#/get/{r[0]}",
        }
        if clearnet_url:
            entry["clearnet_link"] = f"{clearnet_url}/#/get/{r[0]}"
        result.append(entry)

    return web.json_response(result)


# ========== MIDDLEWARE ==========
@web.middleware
async def cors_middleware(request, handler):
    if request.method == "OPTIONS":
        return web.Response(headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept, X-Requested-With",
        })
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Expose-Headers"] = "X-Download-Token"
    return response


@web.middleware
async def rate_limit_middleware(request, handler):
    if request.method != "GET" or "download" not in request.path:
        return await handler(request)
    share_id = request.match_info.get("share_id")
    if not share_id:
        return await handler(request)
    rate_limit_store[share_id] = rate_limit_store.get(share_id, 0) + 1
    if rate_limit_store[share_id] > 10:
        return web.json_response({"error": "Too many requests"}, status=429)

    async def reset():
        await asyncio.sleep(60)
        rate_limit_store.pop(share_id, None)

    asyncio.create_task(reset())
    return await handler(request)


# ========== CLEANUP ==========
async def cleanup_expired_shares():
    while True:
        try:
            for share_id, ipfs_hash in share_metadata.get_all_expired():
                ipfs_pin_rm(ipfs_hash)
                share_metadata.stop_share(share_id)
                logger.info(f"Cleaned up expired share: {share_id}")
        except Exception as e:
            logger.error(f"Cleanup error: {e}", exc_info=True)
        await asyncio.sleep(3600)


# ========== STARTUP ==========
async def on_startup(app):
    global tor_service, service_id, clearnet_url
    tor_service = start_tor_service()
    service_id = tor_service.service_id
    logger.info(f"Tor hidden service started: {service_id}.onion")
    clearnet_url = os.environ.get("CLEARNET_URL") or None
    asyncio.create_task(cleanup_expired_shares())


# ========== APP ==========
app = web.Application(
    middlewares=[cors_middleware, rate_limit_middleware],
    client_max_size=50 * 1024**3
)

# API routes first
app.router.add_post("/upload", upload_file)
app.router.add_get("/download/{share_id}", download_file)
app.router.add_get("/download-progress/{token}", get_download_progress)
app.router.add_get("/status/{share_id}", check_status)
app.router.add_get("/ws/progress/{share_id}", websocket_progress)
app.router.add_post("/stop/{share_id}", stop_sharing)
app.router.add_get("/history", get_share_history)
app.router.add_route("OPTIONS", "/{path_info:.*}", lambda r: web.Response())

# Frontend routes after
app.router.add_get('/', serve_frontend)
app.router.add_get('/static/{filename:.*}', serve_static)
app.router.add_get('/get/{share_id}', serve_frontend)
app.router.add_get('/{filename:[^/]+}', serve_root_file)

app.on_startup.append(on_startup)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=5000)