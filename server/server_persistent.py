import hashlib
import os
import base64
import secrets
import json
import asyncio
import logging
import zipfile
import ipfshttpclient
from aiohttp import web, WSMsgType
from aiohttp_sse import sse_response
from stem.control import Controller
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCDataChannel
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from io import BytesIO
import tempfile
import time
from pathlib import Path
from aiohttp.web_response import StreamResponse
from aiohttp.web import HTTPRequestRangeNotSatisfiable, HTTPPartialContent
import sqlite3

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# IPFS client
import time
import ipfshttpclient

MAX_RETRIES = 10
WAIT_SECONDS = 1

for attempt in range(MAX_RETRIES):
    try:
        ipfs = ipfshttpclient.connect("/ip4/127.0.0.1/tcp/5001/http")
        ipfs.version()  # quick test
        break
    except Exception as e:
        print(f"IPFS not ready, retrying... ({attempt+1}/{MAX_RETRIES})")
        time.sleep(WAIT_SECONDS)
else:
    raise Exception("Failed to connect to IPFS after several retries")


# Tor service globals
tor_service = None
service_id = None

# WebRTC peer connections
pcs = {}

# Upload progress and WebSocket tracking
upload_progress_store = {}
websocket_connections = {}

# Constants
MAX_MEMORY_SIZE = 10 * 1024 * 1024  # 10MB
DEFAULT_TTL = 24 * 60 * 60  # 24h


# ========== PERSISTENT METADATA ==========


class ShareMetadata:
    def __init__(self, db_path="metadata.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
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
                    magnet_created INTEGER NOT NULL DEFAULT 0
                );
            """
            )
            conn.commit()

    async def create_share(
        self,
        ipfs_hash,
        filename,
        content_type,
        private_key,
        max_downloads=1,
        expires_at=None,
        share_id=None,
    ):
        share_id = share_id or secrets.token_urlsafe(16)
        expires_at = expires_at or (time.time() + DEFAULT_TTL)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO share_metadata (share_id, ipfs_hash, filename, content_type,
                                            private_key, max_downloads, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    share_id,
                    ipfs_hash,
                    filename,
                    content_type,
                    private_key,
                    max_downloads,
                    expires_at,
                ),
            )
            conn.commit()
        return share_id

    async def check_download_limits(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT active, download_count, max_downloads, expires_at FROM share_metadata WHERE share_id = ?",
                (share_id,),
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
            cur = conn.execute(
                "SELECT * FROM share_metadata WHERE share_id = ?", (share_id,)
            )
            row = cur.fetchone()
            if not row:
                return None
            return dict(zip([col[0] for col in cur.description], row))

    def increment_download_count(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT download_count, max_downloads FROM share_metadata WHERE share_id = ?",
                (share_id,),
            )
            row = cur.fetchone()
            if row:
                count, max_dl = row
                new_count = count + 1
                active = 0 if new_count >= max_dl else 1
                conn.execute(
                    """
                    UPDATE share_metadata SET download_count = ?, active = ?
                    WHERE share_id = ?
                """,
                    (new_count, active, share_id),
                )
                conn.commit()

    def stop_share(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT ipfs_hash FROM share_metadata WHERE share_id = ?", (share_id,)
            )
            row = cur.fetchone()
            if row:
                ipfs_hash = row[0]
                conn.execute(
                    "UPDATE share_metadata SET active = 0 WHERE share_id = ?",
                    (share_id,),
                )
                conn.commit()
                return ipfs_hash
        return None

    def get_all_expired(self):
        now = time.time()
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT share_id, ipfs_hash FROM share_metadata WHERE expires_at <= ?",
                (now,),
            )
            return cur.fetchall()

    def is_active(self, share_id):
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT active FROM share_metadata WHERE share_id = ?", (share_id,)
            )
            row = cur.fetchone()
            return bool(row and row[0])


# Instantiate it
share_metadata = ShareMetadata()


import time
from stem import SocketError


def start_tor_service():
    for _ in range(5):  # retry up to 5 times
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


async def handle_signaling(request, share_id):
    async with sse_response(request) as resp:
        pcs[share_id] = RTCPeerConnection()
        pc = pcs[share_id]

        @pc.on("datachannel")
        def on_datachannel(channel):
            @channel.on("message")
            def on_message(message):
                channel.send("File received")

        # Create offer
        await pc.setLocalDescription(await pc.createOffer())
        await resp.send(
            json.dumps(
                {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
            )
        )

        # Handle incoming signaling messages
        async for msg in request.content:
            data = json.loads(msg)
            if data["type"] == "answer":
                await pc.setRemoteDescription(
                    RTCSessionDescription(sdp=data["sdp"], type=data["type"])
                )
            elif data["type"] == "candidate":
                await pc.addIceCandidate(data["candidate"])
        return resp


async def download_file(request):
    share_id = request.match_info["share_id"]

    try:
        # Check download limits
        await share_metadata.check_download_limits(share_id)

        # Increment download count
        metadata = share_metadata.get_metadata(share_id)
        if not metadata:
            return web.json_response({"error": "Invalid or expired link"}, status=404)

        share_metadata.increment_download_count(share_id)

        ipfs_hash = metadata["ipfs_hash"]
        encrypted_data = ipfs.cat(ipfs_hash)

        # Extract encryption components from stored data
        encrypted_key = encrypted_data[:256]  # RSA encrypted AES key
        tag = encrypted_data[256:272]  # GCM tag
        nonce = encrypted_data[272:284]  # GCM nonce
        ciphertext = encrypted_data[284:]  # AES-GCM ciphertext

        # Load RSA private key and decrypt AES key
        private_key = serialization.load_pem_private_key(
            metadata["private_key"].encode(), password=None
        )
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
        file_size = len(ciphertext)

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": metadata["content_type"],
                "Content-Disposition": f'attachment; filename="{metadata["filename"]}"',
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
            },
        )

        range_header = request.headers.get("Range")
        if range_header:
            try:
                response.set_status(HTTPPartialContent.status_code)
                start, end = parse_range_header(range_header, file_size)
                response.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
                response.headers["Content-Length"] = str(end - start + 1)
                ciphertext = ciphertext[start : end + 1]
            except ValueError:
                raise HTTPRequestRangeNotSatisfiable()

        await response.prepare(request)
        chunk_size = 8192
        for i in range(0, len(ciphertext), chunk_size):
            decrypted_chunk = decryptor.update(ciphertext[i : i + chunk_size])
            await response.write(decrypted_chunk)
        await response.write(decryptor.finalize())
        await response.write_eof()
        return response

    except ValueError as e:
        return web.json_response({"error": str(e)}, status=403)
    except Exception as e:
        logger.error(f"Error downloading file: {str(e)}", exc_info=True)
        return web.json_response({"error": "Internal server error"}, status=500)


def parse_range_header(range_header, file_size):
    """Parse Range header and return (start, end) tuple"""
    if not range_header.startswith("bytes="):
        raise ValueError("Invalid range unit")
    ranges = range_header[6:].split("-")
    if len(ranges) != 2:
        raise ValueError("Invalid range format")
    start = int(ranges[0]) if ranges[0] else 0
    end = int(ranges[1]) if ranges[1] else file_size - 1
    if start >= file_size or end >= file_size or start > end:
        raise ValueError("Unsatisfiable range")
    return start, end


# # Encryption utilities
def generate_key_pair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    return private_key, public_key


from zipfile import ZipFile


async def upload_file(request):
    try:
        reader = await request.multipart()
        if not reader:
            return web.json_response({"error": "No files uploaded"}, status=400)

        max_downloads = int(request.query.get("max_downloads", 1))
        if max_downloads < 1:
            return web.json_response(
                {"error": "Max downloads must be at least 1"}, status=400
            )

        private_key, public_key = generate_key_pair()
        share_id = request.query.get("share_id") or secrets.token_urlsafe(16)
        upload_progress_store[share_id] = 0

        file_parts = []
        async for part in reader:
            if part.name != "files":
                continue

            filename = Path(part.filename).name
            temp_file = tempfile.NamedTemporaryFile(delete=False)
            temp_path = temp_file.name

            while True:
                chunk = await part.read_chunk(8192)
                if not chunk:
                    break
                temp_file.write(chunk)
            temp_file.close()

            file_parts.append(
                {
                    "filename": filename,
                    "temp_path": temp_path,
                    "content_type": part.headers.get(
                        "Content-Type", "application/octet-stream"
                    ),
                }
            )

        if len(file_parts) == 0:
            return web.json_response({"error": "No valid files uploaded"}, status=400)

        # === If multiple files, zip them ===
        if len(file_parts) > 1:
            zip_path = tempfile.NamedTemporaryFile(delete=False, suffix=".zip").name
            with ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
                for file in file_parts:
                    zipf.write(file["temp_path"], arcname=file["filename"])

            filename = request.query.get("zip_name", "bundle.zip")
            if not filename.endswith(".zip"):
                filename += ".zip"
            content_type = "application/zip"
            data_path = zip_path
        else:
            # Single file case
            filename = file_parts[0]["filename"]
            content_type = file_parts[0]["content_type"]
            data_path = file_parts[0]["temp_path"]

        # === Encrypt the file ===
        aes_key = os.urandom(32)
        nonce = os.urandom(12)
        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(nonce))
        encryptor = cipher.encryptor()
        buffer = BytesIO()

        total_size = os.path.getsize(data_path)
        processed = 0

        with open(data_path, "rb") as f:
            while chunk := f.read(8192):
                encrypted_chunk = encryptor.update(chunk)
                buffer.write(encrypted_chunk)
                processed += len(chunk)

                progress = min(90, int((processed / total_size) * 90))
                if share_id in websocket_connections:
                    for ws in websocket_connections[share_id]:
                        try:
                            await ws.send_str(
                                json.dumps(
                                    {"progress": progress, "status": "uploading"}
                                )
                            )
                        except:
                            pass

        buffer.write(encryptor.finalize())
        tag = encryptor.tag

        encrypted_content = (
            public_key.encrypt(
                aes_key,
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            )
            + tag
            + nonce
            + buffer.getvalue()
        )

        ipfs_hash = ipfs.add_bytes(encrypted_content)

        await share_metadata.create_share(
            ipfs_hash,
            filename,
            content_type,
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            ).decode(),
            max_downloads=max_downloads,
            share_id=share_id,
        )

        # Cleanup temp files
        for f in file_parts:
            os.remove(f["temp_path"])
        if len(file_parts) > 1:
            os.remove(zip_path)

        if share_id in websocket_connections:
            for ws in websocket_connections[share_id]:
                try:
                    await ws.send_str(
                        json.dumps({"progress": 100, "status": "complete"})
                    )
                    await ws.close()
                except:
                    pass

        return web.json_response(
            {
                "share_links": [
                    {
                        "share_id": share_id,
                        "share_link": f"http://{service_id}.onion/download/{share_id}",
                        "filename": filename,
                        "max_downloads": max_downloads,
                    }
                ]
            }
        )

    except Exception as e:
        logger.error(f"Upload error: {e}", exc_info=True)
        return web.json_response({"error": "Internal server error"}, status=500)


async def websocket_progress(request):
    share_id = request.match_info["share_id"]
    if not share_id or share_id == "null":
        logger.warning(f"Invalid share_id: {share_id}")
        return web.json_response({"error": "Invalid share ID"}, status=400)

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    logger.info(f"WebSocket connected for share_id: {share_id}")

    # Store WebSocket connection
    if share_id not in websocket_connections:
        websocket_connections[share_id] = []
    websocket_connections[share_id].append(ws)

    try:
        # Keep WebSocket open until upload completes or client disconnects
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                if msg.data == "close":
                    await ws.close()
                elif msg.type == WSMsgType.ERROR:
                    logger.error(
                        f"WebSocket error for share_id {share_id}: {ws.exception()}"
                    )
                    break
    finally:
        # Clean up WebSocket connection
        if share_id in websocket_connections and ws in websocket_connections[share_id]:
            websocket_connections[share_id].remove(ws)
        if not websocket_connections[share_id]:
            del websocket_connections[share_id]
        logger.info(f"WebSocket disconnected for share_id: {share_id}")
        await ws.close()
    return ws


async def stop_sharing(request):
    share_id = request.match_info["share_id"]
    ipfs_hash = share_metadata.stop_share(share_id)
    if not ipfs_hash:
        return web.json_response({"error": "Invalid share ID"}, status=404)

    try:
        ipfs.pin.rm(ipfs_hash)
    except Exception as e:
        logger.warning(f"Failed to unpin IPFS hash {ipfs_hash}: {e}")

    logger.info(f"Stopped sharing for share_id: {share_id}")
    return web.json_response({"status": "stopped", "share_id": share_id})


# CORS middleware
async def cors_middleware(app, handler):
    async def middleware(request):
        response = await handler(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = (
            "Content-Type, Accept, X-Requested-With, Upgrade, Connection"
        )
        return response

    return middleware


# Rate limiting middleware
from aiohttp import web


@web.middleware
async def rate_limit_middleware(request, handler):
    share_id = request.match_info.get("share_id")
    if not share_id:
        return await handler(request)

    # Simple in-memory rate limiting (not persistent)
    if share_id not in upload_progress_store:
        upload_progress_store[share_id] = 0

    upload_progress_store[share_id] += 1
    if upload_progress_store[share_id] > 10:  # limit per minute
        return web.json_response({"error": "Too many requests"}, status=429)

    # Reset counter after 60 seconds asynchronously
    async def reset_counter():
        await asyncio.sleep(60)
        upload_progress_store.pop(share_id, None)

    asyncio.create_task(reset_counter())
    return await handler(request)


# Cleanup task
async def cleanup_expired_shares():
    while True:
        try:
            expired_items = share_metadata.get_all_expired()
            for share_id, ipfs_hash in expired_items:
                try:
                    ipfs.pin.rm(ipfs_hash)
                    logger.info(f"Unpinned expired share: {share_id}")
                except Exception as e:
                    logger.warning(f"Failed to unpin IPFS hash {ipfs_hash}: {e}")
                share_metadata.stop_share(share_id)
        except Exception as e:
            logger.error(f"Error during cleanup task: {e}", exc_info=True)

        await asyncio.sleep(3600)  # Run every hour


# Application setup
async def on_startup(app):
    global tor_service, service_id
    tor_service = start_tor_service()
    service_id = tor_service.service_id
    logger.info(f"Tor hidden service started: {service_id}.onion")

    # Start cleanup task
    asyncio.create_task(cleanup_expired_shares())


async def check_status(request):
    share_id = request.match_info["share_id"]
    if not share_metadata.is_active(share_id):
        return web.json_response({"active": False})
    return web.json_response({"active": True})


async def get_share_history(request):
    with sqlite3.connect("metadata.db") as conn:
        cur = conn.execute(
            """
            SELECT share_id, filename, max_downloads, download_count, active, expires_at, magnet_created
            FROM share_metadata
            ORDER BY expires_at DESC
        """
        )
        rows = cur.fetchall()
        result = [
            {
                "share_id": r[0],
                "filename": r[1],
                "max_downloads": r[2],
                "download_count": r[3],
                "active": bool(r[4]),
                "expires_at": r[5],
                "share_link": f"http://{service_id}.onion/download/{r[0]}",
                "magnet_created": bool(r[6]),
            }
            for r in rows
        ]
        return web.json_response(result)


app = web.Application(
    middlewares=[cors_middleware, rate_limit_middleware], client_max_size=20 * 1024**3
)

app.router.add_post("/upload", upload_file)
app.router.add_get("/download/{share_id}", download_file)
app.router.add_get("/signal/{share_id}", handle_signaling)
app.router.add_get("/status/{share_id}", check_status)
app.router.add_get("/ws/progress/{share_id}", websocket_progress)
app.router.add_post("/stop/{share_id}", stop_sharing)
app.router.add_get("/history", get_share_history)

app.on_startup.append(on_startup)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=5000)
