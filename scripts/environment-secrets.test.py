import base64
import contextlib
import ctypes
from ctypes.util import find_library
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


PREFLIGHT, PROGRAM = json.load(sys.stdin)


class TransferFixtures(unittest.TestCase):
    def setUp(self):
        self.namespace = {"__name__": "fixture"}
        exec(compile(PROGRAM, "reviewed-inline-sealer", "exec"), self.namespace)
        self.values = {name: f" fixture:{name} 中文 🚀\r\n" for name in self.namespace["INVENTORY"]}
        self.context = {
            "GITHUB_REPOSITORY": "gloom-sh/gloomberb", "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "ImageOS": "ubuntu24",
            "ImageVersion": "20261111.370.1", "RUNNER_ENVIRONMENT": "github-hosted",
        }

    def test_bad_values_are_rejected_before_any_encryption(self):
        name = next(iter(self.values))
        for value in ("", "x" * 49153, "\ud800"):
            with self.subTest(value_type=type(value).__name__):
                sodium = Mock()
                with self.assertRaises((ValueError, UnicodeError)):
                    self.namespace["seal_values"](sodium, {**self.values, name: value}, self.namespace["PUBLIC_KEYS"])
                sodium.crypto_box_seal.assert_not_called()
        for values in ({}, {**self.values, "UNEXPECTED": "fixture"}):
            with self.assertRaises(ValueError):
                self.namespace["seal_values"](Mock(), values, self.namespace["PUBLIC_KEYS"])

    def test_bad_destinations_and_public_keys_are_rejected_before_any_encryption(self):
        original = self.namespace["PUBLIC_KEYS"]
        cases = [
            {}, {**original, "other": original["release"]},
            {**original, "release": ("invalid", original["release"][1])},
            {**original, "release": ("1", "invalid")},
            {**original, "release": ("1", base64.b64encode(b"short").decode())},
            {**original, "release": original["signing-main"]},
        ]
        for public_keys in cases:
            sodium = Mock()
            with self.assertRaises(ValueError):
                self.namespace["seal_values"](sodium, self.values, public_keys)
            sodium.crypto_box_seal.assert_not_called()

    def test_image_and_library_failures_never_load_unverified_crypto(self):
        for changes, contents in (
            ({"RUNNER_ENVIRONMENT": "self-hosted"}, b"fixture"),
            ({"ImageVersion": "other-image"}, b"fixture"),
            ({}, b"corrupted-library"),
            ({}, FileNotFoundError("fixture-library-unavailable")),
        ):
            for mode in ("preflight", "sealer"):
                with self.subTest(mode=mode), patch.dict(os.environ, {**self.context, **changes}, clear=True), \
                     patch("platform.machine", return_value="x86_64"), \
                     patch.object(Path, "read_bytes") as read, patch.object(ctypes, "CDLL") as load:
                    if isinstance(contents, Exception):
                        read.side_effect = contents
                    else:
                        read.return_value = contents
                    if mode == "preflight":
                        with self.assertRaises(SystemExit) as failure:
                            exec(compile(PREFLIGHT, "reviewed-inline-preflight", "exec"), {})
                        self.assertEqual(str(failure.exception), "Reviewed hosted crypto runtime unavailable.")
                    else:
                        with self.assertRaises((ValueError, FileNotFoundError)):
                            self.namespace["load_sodium"]()
                    load.assert_not_called()

    def call_main(self, environment):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, environment, clear=True), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = self.namespace["main"]()
        return result, stdout.getvalue(), stderr.getvalue()

    def test_non_main_or_non_manual_context_creates_no_artifact(self):
        for changes in ({"GITHUB_REF": "refs/heads/other"}, {"GITHUB_EVENT_NAME": "push"},
                        {"GITHUB_REPOSITORY": "another/repo"}, {"RUNNER_DEBUG": "1"}):
            with tempfile.TemporaryDirectory() as directory:
                load = Mock()
                with patch.dict(self.namespace, {"load_sodium": load}):
                    self.assertEqual(self.call_main({**self.context, **self.values, **changes, "RUNNER_TEMP": directory}),
                                     (1, "", "Unable to seal workflow inputs.\n"))
                load.assert_not_called()
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_runtime_failure_never_prints_values_or_creates_an_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            load = Mock(side_effect=RuntimeError(next(iter(self.values.values()))))
            with patch.dict(self.namespace, {"load_sodium": load}):
                self.assertEqual(self.call_main({**self.context, **self.values, "RUNNER_TEMP": directory}),
                                 (1, "", "Unable to seal workflow inputs.\n"))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_encryption_failure_leaves_no_partial_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            sodium = Mock()
            sodium.crypto_box_seal.side_effect = [0, -1]
            with patch.dict(self.namespace, {"load_sodium": lambda: sodium}):
                self.assertEqual(self.call_main({**self.context, **self.values, "RUNNER_TEMP": directory}),
                                 (1, "", "Unable to seal workflow inputs.\n"))
            self.assertEqual(sodium.crypto_box_seal.call_count, 2)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_round_trip_ciphertext_only_artifact_and_exclusive_output(self):
        library = find_library("sodium")
        self.assertIsNotNone(library, "The fixture round trip requires the installed system libsodium")
        sodium = self.namespace["configure"](ctypes.CDLL(library))
        sodium.crypto_box_keypair.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        sodium.crypto_box_keypair.restype = ctypes.c_int
        sodium.crypto_box_seal_open.argtypes = (
            ctypes.c_void_p, ctypes.c_char_p, ctypes.c_ulonglong, ctypes.c_char_p, ctypes.c_char_p,
        )
        sodium.crypto_box_seal_open.restype = ctypes.c_int
        public_keys, pairs = {}, {}
        for destination in self.namespace["PUBLIC_KEYS"]:
            public, private = ctypes.create_string_buffer(32), ctypes.create_string_buffer(32)
            self.assertEqual(sodium.crypto_box_keypair(public, private), 0)
            public_keys[destination] = ("123", base64.b64encode(public.raw).decode())
            pairs[destination] = (public.raw, private.raw)
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(self.namespace, {"load_sodium": lambda: sodium, "PUBLIC_KEYS": public_keys}):
            environment = {**self.context, **self.values, "RUNNER_TEMP": directory}
            self.assertEqual(self.call_main(environment), (0, "Sealed 19 entries.\n", ""))
            artifact = Path(directory) / "environment-secrets.json"
            content = artifact.read_bytes()
            self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
            rows = json.loads(content)["secrets"]
            expected = {(destination, name) for name in (*self.namespace["APPLE"], "HOMEBREW_TAP_TOKEN")
                        for destination in ("release", "signing-main")}
            expected |= {("release", "PLATFORM_DISPATCH_TOKEN"), ("web-production", "CLOUDFLARE_ACCOUNT_ID"),
                         ("web-production", "CLOUDFLARE_API_TOKEN")}
            self.assertEqual(len(rows), 19)
            self.assertEqual({(row["environment"], row["name"]) for row in rows}, expected)
            for row in rows:
                self.assertEqual(set(row), {"environment", "name", "key_id", "encrypted_value"})
                ciphertext = base64.b64decode(row["encrypted_value"], validate=True)
                plaintext = ctypes.create_string_buffer(len(ciphertext) - 48)
                public, private = pairs[row["environment"]]
                self.assertEqual(sodium.crypto_box_seal_open(plaintext, ciphertext, len(ciphertext), public, private), 0)
                self.assertEqual(plaintext.raw, self.values[row["name"]].encode("utf-8"))
                self.assertNotIn(plaintext.raw, content)
                corrupted = ciphertext[:-1] + bytes([ciphertext[-1] ^ 1])
                self.assertNotEqual(sodium.crypto_box_seal_open(plaintext, corrupted, len(corrupted), public, private), 0)
                wrong = next(pair for name, pair in pairs.items() if name != row["environment"])
                self.assertNotEqual(sodium.crypto_box_seal_open(plaintext, ciphertext, len(ciphertext), *wrong), 0)
            self.assertEqual(self.call_main(environment), (1, "", "Unable to seal workflow inputs.\n"))
            self.assertEqual(artifact.read_bytes(), content)


unittest.main(argv=[sys.argv[0], f"TransferFixtures.{sys.argv[1]}"], verbosity=2)
