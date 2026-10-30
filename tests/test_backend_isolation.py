"""Backend security tests without starting external services."""

import tempfile
import unittest

from pathlib import Path

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer

from server.server_persistent import (
    FileShare,
    create_owner_app,
    create_public_app,
)


class BackendSecurityTests(
    unittest.IsolatedAsyncioTestCase
):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

        self.object_store = {}

        ipfs = web.Application()

        async def add(request):
            reader = await request.multipart()
            part = await reader.next()

            ciphertext = await part.read()

            self.object_store["file"] = ciphertext

            return web.Response(
                text=(
                    '{"Name":"data.enc",'
                    '"Hash":"testcid",'
                    '"Size":"1"}\n'
                )
            )

        async def cat(request):
            return web.Response(
                body=self.object_store["file"]
            )

        ipfs.router.add_post(
            "/api/v0/add",
            add,
        )

        ipfs.router.add_post(
            "/api/v0/cat",
            cat,
        )

        self.ipfs = TestClient(
            TestServer(ipfs)
        )

        await self.ipfs.start_server()

        self.service = FileShare(
            db_path=(
                self.root
                / "state"
                / "metadata.db"
            ),
            temp_dir=(
                self.root / "temp"
            ),
            build_dir=(
                self.root / "build"
            ),
            ipfs_api=str(
                self.ipfs.make_url(
                    "/api/v0"
                )
            ).rstrip("/"),
            token="T" * 64,
            tor_port=19351,
        )

        self.service.onion = "test"

        self.owner = TestClient(
            TestServer(
                create_owner_app(
                    self.service
                )
            )
        )

        self.public = TestClient(
            TestServer(
                create_public_app(
                    self.service
                )
            )
        )

        await self.owner.start_server()
        await self.public.start_server()

    async def asyncTearDown(self):
        await self.owner.close()
        await self.public.close()
        await self.ipfs.close()
        self.temp.cleanup()

    async def test_public_cannot_reach_owner_operations(
        self
    ):
        endpoints = (
            ("get", "/history"),
            ("post", "/upload"),
            ("post", "/stop/example"),
            ("get", "/ws/progress/example"),
        )

        for method, path in endpoints:
            with self.subTest(
                path=path
            ):
                response = await getattr(
                    self.public,
                    method,
                )(path)

                self.assertIn(
                    response.status,
                    (404, 405),
                )

    async def test_owner_requires_session_secret(
        self
    ):
        response = await self.owner.get(
            "/history"
        )

        self.assertEqual(
            response.status,
            403,
        )

        response = await self.owner.get(
            "/history",
            headers={
                "X-FileShare-Auth": "wrong"
            },
        )

        self.assertEqual(
            response.status,
            403,
        )

        response = await self.owner.get(
            "/history",
            headers={
                "X-FileShare-Auth": "T" * 64
            },
        )

        self.assertEqual(
            response.status,
            200,
        )

    async def test_verified_transfer_and_limit(
        self
    ):
        payload = (
            b"actual contents\x00" * 40
        )

        form = FormData()

        form.add_field(
            "files",
            payload,
            filename="document.bin",
            content_type=(
                "application/octet-stream"
            ),
        )

        share_id = "s" * 32

        response = await self.owner.post(
            (
                f"/upload?share_id={share_id}"
                "&max_downloads=1"
            ),
            data=form,
            headers={
                "X-FileShare-Auth": "T" * 64
            },
        )

        self.assertEqual(
            response.status,
            200,
            await response.text(),
        )

        self.assertNotIn(
            payload,
            self.object_store["file"],
        )

        response = await self.public.get(
            f"/status/{share_id}"
        )

        self.assertEqual(
            response.status,
            200,
        )

        first = await self.public.get(
            f"/download/{share_id}"
        )

        self.assertEqual(
            first.status,
            200,
            await first.text(),
        )

        self.assertEqual(
            await first.read(),
            payload,
        )

        response = await self.public.get(
            f"/status/{share_id}"
        )

        self.assertFalse(
            (
                await response.json()
            )["active"]
        )

        response = await self.public.get(
            f"/download/{share_id}"
        )

        self.assertEqual(
            response.status,
            404,
        )

        self.assertFalse(
            any(
                self.service.temp_dir.iterdir()
            )
        )

    async def test_invalid_ciphertext_never_releases_plaintext(
        self
    ):
        payload = (
            b"sensitive input" * 4
        )

        form = FormData()

        form.add_field(
            "files",
            payload,
            filename="test.txt",
        )

        share_id = "p" * 32

        result = await self.owner.post(
            f"/upload?share_id={share_id}",
            data=form,
            headers={
                "X-FileShare-Auth": "T" * 64
            },
        )

        self.assertEqual(
            result.status,
            200,
        )

        corrupted = bytearray(
            self.object_store["file"]
        )

        corrupted[-1] ^= 1

        self.object_store["file"] = bytes(
            corrupted
        )

        response = await self.public.get(
            f"/download/{share_id}"
        )

        self.assertNotEqual(
            response.status,
            200,
        )

        response = await self.public.get(
            f"/status/{share_id}"
        )

        self.assertTrue(
            (
                await response.json()
            )["active"]
        )

        self.assertFalse(
            any(
                self.service.temp_dir.iterdir()
            )
        )

    async def test_owner_stop_is_not_undone_by_counter(
        self
    ):
        share_id = "x" * 32

        self.service.shares.create(
            share_id,
            "cid",
            "a.txt",
            "text/plain",
            "key",
            1,
            3,
        )

        self.assertTrue(
            self.service.shares.consume(
                share_id
            )
        )

        self.assertTrue(
            self.service.shares.stop(
                share_id
            )
        )

        self.assertFalse(
            self.service.shares.active(
                share_id
            )
        )

        self.assertFalse(
            self.service.shares.consume(
                share_id
            )
        )

    async def test_development_database_does_not_use_shared_location(
        self
    ):
        self.assertEqual(
            self.service.shares.db_path,
            (
                self.root
                / "state"
                / "metadata.db"
            ),
        )

        self.assertFalse(
            (
                self.root / "metadata.db"
            ).exists()
        )


if __name__ == "__main__":
    unittest.main()