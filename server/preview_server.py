"""Isolated backend entry point for the packaged FileShare Preview.

Only environment supplied by the Preview desktop launcher is accepted.
The existing FileShare and Stage 1 development profiles are never opened.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import web

from server.server_persistent import FileShare, create_owner_app, create_public_app

PORTS = {
    "owner": 25300,
    "public": 25302,
    "ipfs_api": 25301,
    "ipfs_gateway": 28081,
    "ipfs_swarm": 24001,
    "tor_control": 29351,
    "tor_socks": 29350,
}

ONION_RE = re.compile(r"[a-z2-7]{56}\Z")


@dataclass(frozen=True)
class PreviewSettings:
    root: Path
    database: Path
    temporary: Path
    build: Path
    token: str
    onion: str
    clearnet: str | None


def load_settings(
    environ: dict[str, str] | os._Environ[str],
) -> PreviewSettings:
    """Validate all mutable locations against the dedicated preview directory."""
    local = environ.get("LOCALAPPDATA", "")

    if not local:
        raise RuntimeError("LOCALAPPDATA is not defined")

    base = Path(local).resolve(strict=True)
    root = base / "FileSharePreviewRC"

    expected = {
        "FILESHARE_MODE": "preview",
        "FILESHARE_PREVIEW_ROOT": str(root),
        "FILESHARE_DB_PATH": str(
            root / "state" / "metadata.db"
        ),
        "FILESHARE_TEMP_DIR": str(
            root / "temporary"
        ),
        "IPFS_PATH": str(root / "ipfs"),
        "FILESHARE_IPFS_API": (
            "http://127.0.0.1:25301/api/v0"
        ),
        "FILESHARE_OWNER_PORT": "25300",
        "FILESHARE_PUBLIC_PORT": "25302",
        "FILESHARE_TOR_CONTROL_PORT": "29351",
        "FILESHARE_OWNER_HOST": "127.0.0.1",
        "FILESHARE_PUBLIC_HOST": "127.0.0.1",
    }

    for key, value in expected.items():
        if environ.get(key) != value:
            raise RuntimeError(
                f"Invalid preview environment: {key}"
            )

    for child in (
        root,
        root / "state",
        root / "ipfs",
        root / "temporary",
    ):
        if (
            child.exists()
            and child.resolve(strict=True) != child
        ):
            raise RuntimeError(
                f"Redirected preview path: {child}"
            )

    build = Path(
        environ.get("FILESHARE_BUILD_DIR", "")
    )

    if (
        not build.is_absolute()
        or not (build / "index.html").is_file()
    ):
        raise RuntimeError(
            "Preview frontend assets are missing"
        )

    token = environ.get(
        "FILESHARE_ADMIN_TOKEN", ""
    )

    if len(token) < 32:
        raise RuntimeError(
            "Missing preview owner session token"
        )

    onion = environ.get(
        "FILESHARE_ONION_HOST", ""
    ).lower()

    if not ONION_RE.fullmatch(onion):
        raise RuntimeError(
            "Missing valid preview Onion hostname"
        )

    clearnet = (
        environ.get("CLEARNET_URL", "").rstrip("/")
        or None
    )

    if clearnet:
        u = urlparse(clearnet)

        if (
            u.scheme != "https"
            or not u.hostname
            or not u.hostname.endswith(
                ".trycloudflare.com"
            )
            or u.username
            or u.password
            or u.port
            or u.path
            or u.query
            or u.fragment
        ):
            raise RuntimeError(
                "Invalid preview Cloudflare hostname"
            )

    return PreviewSettings(
        root=root,
        database=root / "state" / "metadata.db",
        temporary=root / "temporary",
        build=build,
        token=token,
        onion=onion,
        clearnet=clearnet,
    )


async def serve(
    settings: PreviewSettings,
) -> None:
    service = FileShare(
        db_path=settings.database,
        temp_dir=settings.temporary,
        build_dir=settings.build,
        ipfs_api="http://127.0.0.1:25301/api/v0",
        token=settings.token,
        tor_port=PORTS["tor_control"],
        clearnet_url=settings.clearnet,
    )

    service.onion = settings.onion

    public = web.AppRunner(
        create_public_app(service)
    )

    owner = web.AppRunner(
        create_owner_app(service)
    )

    await public.setup()

    try:
        await web.TCPSite(
            public,
            "127.0.0.1",
            PORTS["public"],
        ).start()

        await owner.setup()

        try:
            await web.TCPSite(
                owner,
                "127.0.0.1",
                PORTS["owner"],
            ).start()

            logging.info(
                "FileShare Preview API started on isolated ports"
            )

            cleanup = asyncio.create_task(
                service.cleanup_expired()
            )

            try:
                await asyncio.Event().wait()
            finally:
                cleanup.cancel()

                await asyncio.gather(
                    cleanup,
                    return_exceptions=True,
                )

        finally:
            await owner.cleanup()

    finally:
        await public.cleanup()


def main() -> int:
    settings = load_settings(os.environ)

    logs = settings.root / "logs"
    logs.mkdir(
        parents=True,
        exist_ok=True,
    )

    logging.basicConfig(
        filename=str(logs / "backend.log"),
        level=logging.INFO,
        format=(
            "%(asctime)s %(levelname)s "
            "%(name)s: %(message)s"
        ),
        encoding="utf-8",
    )

    try:
        asyncio.run(
            serve(settings)
        )
    except KeyboardInterrupt:
        return 0

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())

    except Exception:
        # Windowed PyInstaller executables have no visible console.
        # Persist fatal startup errors only in the preview folder.
        import traceback

        local = os.environ.get(
            "LOCALAPPDATA"
        )

        if local:
            try:
                folder = (
                    Path(local)
                    / "FileSharePreviewRC"
                    / "logs"
                )

                folder.mkdir(
                    parents=True,
                    exist_ok=True,
                )

                with (
                    folder / "backend-startup-error.log"
                ).open(
                    "a",
                    encoding="utf-8",
                ) as output:
                    traceback.print_exc(
                        file=output
                    )

            except OSError:
                pass

        raise SystemExit(1)