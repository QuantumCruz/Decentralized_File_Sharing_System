"""FileShare development backend.

Provides an isolated owner API and public download API.
Only the validated development runtime is supported.
The installed FileShare application and its database are never opened.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import tempfile
import time
import zipfile

from contextlib import closing
from pathlib import Path
from urllib.parse import quote

import aiohttp

from aiohttp import WSMsgType, web

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import (
    Cipher,
    algorithms,
    modes,
)

if __package__:
    from .dev_runtime import load_development_runtime
else:
    from dev_runtime import load_development_runtime


LOG = logging.getLogger("fileshare")

CHUNK = 64 * 1024
TTL = 86400
MAX_BYTES = 5 * 1024**3
MAX_FILES = 100

SHARE_ID = re.compile(
    r"^[A-Za-z0-9_-]{16,128}$"
)


class Shares:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

        self.db_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        with closing(
            sqlite3.connect(self.db_path)
        ) as db, db:
            db.execute("""
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
                )
            """)

    def create(
        self,
        share_id,
        cid,
        filename,
        mime,
        private_key,
        size,
        limit,
    ):
        with closing(
            sqlite3.connect(self.db_path)
        ) as db, db:
            db.execute("""
                INSERT INTO share_metadata
                (
                    share_id,
                    ipfs_hash,
                    filename,
                    content_type,
                    private_key,
                    max_downloads,
                    expires_at,
                    file_size
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                share_id,
                cid,
                filename,
                mime,
                private_key,
                limit,
                time.time() + TTL,
                size,
            ))

    def get(self, share_id):
        with closing(
            sqlite3.connect(self.db_path)
        ) as db:
            cur = db.execute(
                """
                SELECT *
                FROM share_metadata
                WHERE share_id = ?
                """,
                (share_id,),
            )

            row = cur.fetchone()

            if not row:
                return None

            return dict(
                zip(
                    (
                        column[0]
                        for column in cur.description
                    ),
                    row,
                )
            )

    def active(self, share_id):
        with closing(
            sqlite3.connect(self.db_path)
        ) as db:
            return db.execute("""
                SELECT 1
                FROM share_metadata
                WHERE share_id = ?
                    AND active = 1
                    AND expires_at > ?
                    AND download_count < max_downloads
            """, (
                share_id,
                time.time(),
            )).fetchone() is not None

    def consume(self, share_id):
        # Atomically allocate one download.
        # Interrupted downloads still consume an attempt.
        # This avoids accidentally reactivating revoked shares.

        with closing(
            sqlite3.connect(self.db_path)
        ) as db, db:
            cur = db.execute("""
                UPDATE share_metadata
                SET
                    download_count = download_count + 1,
                    active = CASE
                        WHEN download_count + 1 >= max_downloads
                        THEN 0
                        ELSE 1
                    END
                WHERE share_id = ?
                    AND active = 1
                    AND expires_at > ?
                    AND download_count < max_downloads
            """, (
                share_id,
                time.time(),
            ))

            return cur.rowcount == 1

    def stop(self, share_id):
        with closing(
            sqlite3.connect(self.db_path)
        ) as db, db:
            row = db.execute(
                """
                SELECT ipfs_hash
                FROM share_metadata
                WHERE share_id = ?
                """,
                (share_id,),
            ).fetchone()

            if row:
                db.execute(
                    """
                    UPDATE share_metadata
                    SET active = 0
                    WHERE share_id = ?
                    """,
                    (share_id,),
                )

            return row[0] if row else None

    def expired(self):
        with closing(
            sqlite3.connect(self.db_path)
        ) as db:
            return db.execute("""
                SELECT share_id, ipfs_hash
                FROM share_metadata
                WHERE active = 1
                    AND expires_at <= ?
            """, (
                time.time(),
            )).fetchall()

    def history(self):
        with closing(
            sqlite3.connect(self.db_path)
        ) as db:
            return db.execute("""
                SELECT
                    share_id,
                    filename,
                    max_downloads,
                    download_count,
                    active,
                    expires_at
                FROM share_metadata
                ORDER BY expires_at DESC
            """).fetchall()


def safe_filename(name):
    cleaned = (
        str(name or "")
        .replace("\\", "/")
        .split("/")[-1]
    )

    if (
        not cleaned
        or cleaned in (".", "..")
        or any(ord(c) < 32 for c in cleaned)
    ):
        raise web.HTTPBadRequest(
            text="Invalid filename"
        )

    return cleaned


def resolve_asset(
    root: Path,
    name: str,
) -> Path:
    base = root.resolve()
    target = (base / name).resolve()

    if (
        not target.is_relative_to(base)
        or not target.is_file()
    ):
        raise web.HTTPNotFound()

    return target


class FileShare:
    def __init__(
        self,
        *,
        db_path: Path,
        temp_dir: Path,
        build_dir: Path,
        ipfs_api: str,
        token: str,
        tor_port: int,
        clearnet_url: str | None = None,
    ):
        if len(token) < 32:
            raise ValueError(
                "Missing secure owner authentication secret"
            )

        self.shares = Shares(db_path)

        self.temp_dir = Path(temp_dir)
        self.temp_dir.mkdir(
            parents=True,
            exist_ok=True,
        )

        self.build_dir = Path(build_dir)
        self.ipfs_api = ipfs_api.rstrip("/")
        self.token = token
        self.tor_port = tor_port

        self.onion = None
        self.clearnet = clearnet_url

        self.progress = {}
        self.cleanup_task = None

    def links(
        self,
        share_id,
        filename,
        limit,
    ):
        result = []

        if self.onion:
            result.append({
                "share_id": share_id,
                "share_link": (
                    f"http://{self.onion}.onion"
                    f"/#/get/{share_id}"
                ),
                "filename": filename,
                "max_downloads": limit,
                "link_type": "tor",
            })

        if self.clearnet:
            result.append({
                "share_id": share_id,
                "share_link": (
                    f"{self.clearnet}"
                    f"/#/get/{share_id}"
                ),
                "filename": filename,
                "max_downloads": limit,
                "link_type": "clearnet",
            })

        return result

    async def broadcast(
        self,
        share_id,
        progress,
        status,
    ):
        sockets = list(
            self.progress.get(
                share_id,
                [],
            )
        )

        for socket in sockets:
            try:
                await socket.send_json({
                    "progress": progress,
                    "status": status,
                })

            except (
                ConnectionError,
                RuntimeError,
            ):
                LOG.debug(
                    "Progress client disconnected"
                )

    async def ipfs_add(
        self,
        filename,
    ):
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=30,
        )

        async with aiohttp.ClientSession(
            timeout=timeout
        ) as session:
            with open(filename, "rb") as stream:
                form = aiohttp.FormData()

                form.add_field(
                    "file",
                    stream,
                    filename="data.enc",
                    content_type=(
                        "application/octet-stream"
                    ),
                )

                async with session.post(
                    f"{self.ipfs_api}/add",
                    data=form,
                ) as response:
                    response.raise_for_status()

                    final = None

                    async for line in response.content:
                        if line.strip():
                            final = json.loads(line)

                    if (
                        not final
                        or not final.get("Hash")
                    ):
                        raise RuntimeError(
                            "IPFS did not return a content hash"
                        )

                    return final["Hash"]

    async def ipfs_unpin(self, cid):
        try:
            timeout = aiohttp.ClientTimeout(
                total=20
            )

            async with aiohttp.ClientSession(
                timeout=timeout
            ) as session:
                async with session.post(
                    f"{self.ipfs_api}/pin/rm",
                    params={
                        "arg": cid,
                    },
                ) as response:
                    response.raise_for_status()

        except (
            aiohttp.ClientError,
            asyncio.TimeoutError,
        ):
            LOG.warning(
                "Unable to unpin IPFS object: %s",
                cid,
            )

    async def upload(self, request):
        temporary = []

        try:
            try:
                limit = int(
                    request.query.get(
                        "max_downloads",
                        "1",
                    )
                )

            except ValueError:
                raise web.HTTPBadRequest(
                    text=(
                        "Maximum downloads "
                        "must be an integer"
                    )
                )

            if not 1 <= limit <= 100000:
                raise web.HTTPBadRequest(
                    text="Maximum downloads out of range"
                )

            share_id = (
                request.query.get("share_id")
                or secrets.token_urlsafe(24)
            )

            if not SHARE_ID.fullmatch(share_id):
                raise web.HTTPBadRequest(
                    text="Invalid share identifier"
                )

            if self.shares.get(share_id):
                raise web.HTTPConflict(
                    text="This share identifier already exists"
                )

            reader = await request.multipart()

            uploaded = []
            total = 0

            while part := await reader.next():
                if part.name != "files":
                    continue

                if len(uploaded) >= MAX_FILES:
                    raise web.HTTPRequestEntityTooLarge(
                        max_size=MAX_FILES,
                        actual_size=len(uploaded) + 1,
                    )

                name = safe_filename(
                    part.filename
                )

                temp = tempfile.NamedTemporaryFile(
                    dir=self.temp_dir,
                    delete=False,
                )

                temporary.append(
                    Path(temp.name)
                )

                with temp:
                    while chunk := await part.read_chunk(
                        CHUNK
                    ):
                        total += len(chunk)

                        if total > MAX_BYTES:
                            raise web.HTTPRequestEntityTooLarge(
                                max_size=MAX_BYTES,
                                actual_size=total,
                            )

                        temp.write(chunk)

                uploaded.append((
                    name,
                    Path(temp.name),
                    part.headers.get(
                        "Content-Type",
                        "application/octet-stream",
                    ),
                ))

            if not uploaded:
                raise web.HTTPBadRequest(
                    text="No files were selected"
                )

            if len(uploaded) > 1:
                filename = safe_filename(
                    request.query.get(
                        "zip_name",
                        "bundle.zip",
                    )
                )

                if not filename.lower().endswith(
                    ".zip"
                ):
                    filename += ".zip"

                names = {
                    item[0]
                    for item in uploaded
                }

                if len(names) != len(uploaded):
                    raise web.HTTPBadRequest(
                        text=(
                            "The selected files "
                            "include duplicate names"
                        )
                    )

                zip_temp = tempfile.NamedTemporaryFile(
                    dir=self.temp_dir,
                    delete=False,
                    suffix=".zip",
                )

                zipped = Path(zip_temp.name)
                temporary.append(zipped)
                zip_temp.close()

                with zipfile.ZipFile(
                    zipped,
                    "w",
                    compression=zipfile.ZIP_DEFLATED,
                ) as archive:
                    for name, file_path, _ in uploaded:
                        archive.write(
                            file_path,
                            arcname=name,
                        )

                source = zipped
                mime = "application/zip"

            else:
                filename, source, mime = uploaded[0]

            key = rsa.generate_private_key(
                public_exponent=65537,
                key_size=2048,
            )

            aes_key = secrets.token_bytes(32)
            nonce = secrets.token_bytes(12)

            wrapped = key.public_key().encrypt(
                aes_key,
                padding.OAEP(
                    mgf=padding.MGF1(
                        hashes.SHA256()
                    ),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            )

            encryptor = Cipher(
                algorithms.AES(aes_key),
                modes.GCM(nonce),
            ).encryptor()

            enc_temp = tempfile.NamedTemporaryFile(
                dir=self.temp_dir,
                delete=False,
                suffix=".enc",
            )

            encrypted = Path(enc_temp.name)
            temporary.append(encrypted)

            with enc_temp as destination, open(
                source,
                "rb",
            ) as origin:
                destination.write(wrapped)
                destination.write(b"\0" * 16)
                destination.write(nonce)

                processed = 0
                size = source.stat().st_size
                last_percent = -1

                while chunk := origin.read(CHUNK):
                    destination.write(
                        encryptor.update(chunk)
                    )

                    processed += len(chunk)

                    percent = (
                        10 + int(
                            processed * 40 / size
                        )
                        if size
                        else 50
                    )

                    if percent != last_percent:
                        last_percent = percent

                        await self.broadcast(
                            share_id,
                            percent,
                            "encrypting",
                        )

                    await asyncio.sleep(0)

                destination.write(
                    encryptor.finalize()
                )

                destination.seek(256)
                destination.write(encryptor.tag)

            await self.broadcast(
                share_id,
                50,
                "uploading to IPFS",
            )

            cid = await self.ipfs_add(
                encrypted
            )

            await self.broadcast(
                share_id,
                90,
                "finalizing",
            )

            pem = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode()

            try:
                self.shares.create(
                    share_id,
                    cid,
                    filename,
                    mime,
                    pem,
                    encrypted.stat().st_size,
                    limit,
                )

            except Exception:
                await self.ipfs_unpin(cid)
                raise

            await self.broadcast(
                share_id,
                100,
                "complete",
            )

            return web.json_response({
                "share_links": self.links(
                    share_id,
                    filename,
                    limit,
                ),
            })

        finally:
            for file_path in temporary:
                try:
                    file_path.unlink(
                        missing_ok=True
                    )

                except OSError:
                    LOG.warning(
                        "Unable to clean temporary upload: %s",
                        file_path,
                    )

    async def download(self, request):
        share_id = request.match_info[
            "share_id"
        ]

        metadata = self.shares.get(
            share_id
        )

        if (
            not metadata
            or not self.shares.active(share_id)
        ):
            raise web.HTTPNotFound(
                text=(
                    "This link is unavailable "
                    "or expired"
                )
            )

        temp_path = None

        try:
            private_key = (
                serialization.load_pem_private_key(
                    metadata["private_key"].encode(),
                    password=None,
                )
            )

            timeout = aiohttp.ClientTimeout(
                total=None,
                sock_connect=60,
            )

            async with aiohttp.ClientSession(
                timeout=timeout
            ) as session:
                async with session.post(
                    f"{self.ipfs_api}/cat",
                    params={
                        "arg": metadata["ipfs_hash"],
                    },
                ) as response:
                    response.raise_for_status()

                    header = await (
                        response.content.readexactly(
                            284
                        )
                    )

                    aes_key = private_key.decrypt(
                        header[:256],
                        padding.OAEP(
                            mgf=padding.MGF1(
                                hashes.SHA256()
                            ),
                            algorithm=hashes.SHA256(),
                            label=None,
                        ),
                    )

                    decryptor = Cipher(
                        algorithms.AES(aes_key),
                        modes.GCM(
                            header[272:284],
                            header[256:272],
                        ),
                    ).decryptor()

                    out = tempfile.NamedTemporaryFile(
                        dir=self.temp_dir,
                        delete=False,
                    )

                    temp_path = Path(
                        out.name
                    )

                    with out:
                        async for chunk in (
                            response.content.iter_chunked(
                                CHUNK
                            )
                        ):
                            out.write(
                                decryptor.update(
                                    chunk
                                )
                            )

                        # Verify the entire encrypted object
                        # before sending any plaintext.
                        out.write(
                            decryptor.finalize()
                        )

            # Allocate one download atomically.
            # Disconnected transfers consume an attempt.
            if not self.shares.consume(
                share_id
            ):
                raise web.HTTPForbidden(
                    text=(
                        "The download limit "
                        "has been reached"
                    )
                )

            filename = safe_filename(
                metadata["filename"]
            ).replace('"', "_")

            output = web.StreamResponse(
                status=200,
                headers={
                    "Content-Type": (
                        metadata["content_type"]
                    ),
                    "Content-Disposition": (
                        "attachment; "
                        "filename*=UTF-8''"
                        + quote(filename)
                    ),
                    "Content-Length": str(
                        temp_path.stat().st_size
                    ),
                    "Cache-Control": "no-store",
                },
            )

            await output.prepare(
                request
            )

            with open(temp_path, "rb") as source:
                while chunk := source.read(CHUNK):
                    await output.write(
                        chunk
                    )

            await output.write_eof()

            return output

        except web.HTTPException:
            raise

        except (
            aiohttp.ClientError,
            ValueError,
            OSError,
            asyncio.IncompleteReadError,
            InvalidTag,
        ):
            LOG.exception(
                "Download failed"
            )

            raise web.HTTPBadGateway(
                text="Unable to retrieve the file"
            )

        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink(
                        missing_ok=True
                    )

                except OSError:
                    LOG.warning(
                        "Unable to remove verified download: %s",
                        temp_path,
                    )

    async def stop(self, request):
        share_id = request.match_info[
            "share_id"
        ]

        cid = self.shares.stop(
            share_id
        )

        if not cid:
            raise web.HTTPNotFound()

        await self.ipfs_unpin(cid)

        return web.json_response({
            "status": "stopped",
            "share_id": share_id,
        })

    async def history(self, request):
        results = []

        for (
            share_id,
            filename,
            limit,
            count,
            active,
            expires,
        ) in self.shares.history():

            row = {
                "share_id": share_id,
                "filename": filename,
                "max_downloads": limit,
                "download_count": count,
                "active": bool(
                    active
                    and expires > time.time()
                    and count < limit
                ),
                "expires_at": expires,
                "tor_link": None,
                "clearnet_link": None,
            }

            for link in self.links(
                share_id,
                filename,
                limit,
            ):
                field = (
                    "tor_link"
                    if link["link_type"] == "tor"
                    else "clearnet_link"
                )

                row[field] = link[
                    "share_link"
                ]

            results.append(row)

        return web.json_response(
            results
        )

    async def status(self, request):
        share_id = request.match_info[
            "share_id"
        ]

        return web.json_response({
            "active": self.shares.active(
                share_id
            ),
        })

    async def websocket(self, request):
        share_id = request.match_info[
            "share_id"
        ]

        if not SHARE_ID.fullmatch(
            share_id
        ):
            raise web.HTTPBadRequest(
                text="Invalid share identifier"
            )

        ws = web.WebSocketResponse()

        await ws.prepare(
            request
        )

        self.progress.setdefault(
            share_id,
            [],
        ).append(ws)

        try:
            async for msg in ws:
                if (
                    msg.type == WSMsgType.TEXT
                    and msg.data == "close"
                ):
                    break

        finally:
            entries = self.progress.get(
                share_id,
                [],
            )

            if ws in entries:
                entries.remove(ws)

            if not entries:
                self.progress.pop(
                    share_id,
                    None,
                )

        return ws

    async def frontend(self, request):
        target = (
            self.build_dir / "index.html"
        )

        if not target.is_file():
            raise web.HTTPServiceUnavailable(
                text=(
                    "Frontend has not been built"
                )
            )

        return web.FileResponse(
            target
        )

    async def static(self, request):
        target = resolve_asset(
            self.build_dir / "static",
            request.match_info["filename"],
        )

        return web.FileResponse(
            target
        )

    async def root_asset(self, request):
        target = resolve_asset(
            self.build_dir,
            request.match_info["filename"],
        )

        return web.FileResponse(
            target
        )

    async def cleanup_expired(self):
        while True:
            await asyncio.sleep(
                3600
            )

            for (
                share_id,
                cid,
            ) in self.shares.expired():
                await self.ipfs_unpin(cid)

                self.shares.stop(
                    share_id
                )


def create_owner_app(
    service: FileShare,
):
    @web.middleware
    async def owner_only(request, handler):
        supplied = request.headers.get(
            "X-FileShare-Auth",
            "",
        )

        if not hmac.compare_digest(
            supplied,
            service.token,
        ):
            raise web.HTTPForbidden(
                text="Owner authentication required"
            )

        return await handler(
            request
        )

    app = web.Application(
        middlewares=[owner_only],
        client_max_size=MAX_BYTES,
    )

    app.router.add_post(
        "/upload",
        service.upload,
    )

    app.router.add_post(
        "/stop/{share_id}",
        service.stop,
    )

    app.router.add_get(
        "/history",
        service.history,
    )

    app.router.add_get(
        "/ws/progress/{share_id}",
        service.websocket,
    )

    app.router.add_get(
        "/status/{share_id}",
        service.status,
    )

    app.router.add_get(
        "/",
        service.frontend,
    )

    app.router.add_get(
        "/static/{filename:.*}",
        service.static,
    )

    app.router.add_get(
        "/{filename:[^/]+}",
        service.root_asset,
    )

    return app


def create_public_app(
    service: FileShare,
):
    app = web.Application()

    # Only routes required by recipients.
    # No upload, history, stop, or WebSocket APIs.
    app.router.add_get(
        "/download/{share_id}",
        service.download,
        allow_head=False,
    )

    app.router.add_get(
        "/status/{share_id}",
        service.status,
    )

    app.router.add_get(
        "/",
        service.frontend,
    )

    app.router.add_get(
        "/static/{filename:.*}",
        service.static,
    )

    app.router.add_get(
        "/{filename:[^/]+}",
        service.root_asset,
    )

    return app


def validate_launch_environment(
    runtime,
):
    expected = {
        "FILESHARE_MODE": "development",
        "FILESHARE_DB_PATH": str(
            runtime.database
        ),
        "FILESHARE_IPFS_API": (
            runtime.ipfs_api_url
        ),
        "FILESHARE_OWNER_PORT": str(
            runtime.ports["owner"]
        ),
        "FILESHARE_PUBLIC_PORT": str(
            runtime.ports["public"]
        ),
        "FILESHARE_TOR_CONTROL_PORT": str(
            runtime.ports["tor_control"]
        ),
        "IPFS_PATH": str(
            runtime.ipfs_repo
        ),
    }

    for name, value in expected.items():
        if os.environ.get(name) != value:
            raise RuntimeError(
                "Missing or incorrect "
                "development environment: "
                + name
            )

    token = os.environ.get(
        "FILESHARE_ADMIN_TOKEN",
        "",
    )

    if len(token) < 32:
        raise RuntimeError(
            "Missing authenticated owner session token"
        )

    return token


async def main():
    root = Path(__file__).resolve().parents[1]

    runtime = load_development_runtime(
        root
    )

    token = validate_launch_environment(
        runtime
    )

    service = FileShare(
        db_path=runtime.database,
        temp_dir=runtime.temporary,
        build_dir=(
            root / "server" / "build"
        ),
        ipfs_api=runtime.ipfs_api_url,
        token=token,
        tor_port=runtime.ports["tor_control"],
        clearnet_url=(
            os.environ.get("CLEARNET_URL")
            or None
        ),
    )

    owner_runner = web.AppRunner(
        create_owner_app(service)
    )

    public_runner = web.AppRunner(
        create_public_app(service)
    )

    await public_runner.setup()

    try:
        await web.TCPSite(
            public_runner,
            "127.0.0.1",
            runtime.ports["public"],
        ).start()

        await owner_runner.setup()

        try:
            await web.TCPSite(
                owner_runner,
                "127.0.0.1",
                runtime.ports["owner"],
            ).start()

            # Tor and Cloudflare process integration
            # will be enabled only after the isolated
            # desktop lifecycle has been tested.
            LOG.info(
                "Backend isolation ready. "
                "Owner controls: %s; public: %s",
                runtime.owner_url,
                runtime.public_url,
            )

            service.cleanup_task = (
                asyncio.create_task(
                    service.cleanup_expired()
                )
            )

            await asyncio.Event().wait()

        finally:
            if service.cleanup_task:
                service.cleanup_task.cancel()

                await asyncio.gather(
                    service.cleanup_task,
                    return_exceptions=True,
                )

            await owner_runner.cleanup()

    finally:
        await public_runner.cleanup()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO
    )

    asyncio.run(main())