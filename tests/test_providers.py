"""Tests for parliament.providers — no real inference servers required.

All HTTP calls are intercepted via unittest.mock.patch on
urllib.request.urlopen so CI runs without any local model backend.
"""

from __future__ import annotations

import io
import json
import os
import unittest
import urllib.error
from contextlib import contextmanager
from typing import Generator
from unittest.mock import MagicMock, patch

from parliament.providers import get_provider
from parliament.providers.errors import ModelConnectionError
from parliament.providers.lm_studio import LMStudioProvider
from parliament.providers.ollama import OllamaProvider
from parliament.providers.omlx import oMLXProvider


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_response(body: dict) -> MagicMock:
    """Return a mock urllib response that yields *body* as JSON bytes."""
    raw = json.dumps(body).encode()
    mock_resp = MagicMock()
    mock_resp.read.return_value = raw
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp


def _make_url_error(reason: str) -> urllib.error.URLError:
    return urllib.error.URLError(reason)


@contextmanager
def _mock_urlopen(response: MagicMock) -> Generator[MagicMock, None, None]:
    with patch("urllib.request.urlopen", return_value=response) as mock:
        yield mock


@contextmanager
def _mock_urlopen_raising(exc: Exception) -> Generator[MagicMock, None, None]:
    with patch("urllib.request.urlopen", side_effect=exc) as mock:
        yield mock


# ---------------------------------------------------------------------------
# OllamaProvider
# ---------------------------------------------------------------------------

class TestOllamaProvider(unittest.TestCase):

    def test_happy_path_returns_message_content(self):
        body = {"message": {"role": "assistant", "content": "Hello from Ollama"}}
        provider = OllamaProvider()

        with _mock_urlopen(_make_response(body)) as mock_open:
            result = provider.generate("llama3.2", "What is 2+2?", "You are helpful.")

        self.assertEqual(result, "Hello from Ollama")
        mock_open.assert_called_once()

        # Verify the request was constructed correctly
        req = mock_open.call_args[0][0]
        self.assertEqual(req.full_url, "http://localhost:11434/api/chat")
        self.assertEqual(req.get_method(), "POST")

        sent_body = json.loads(req.data.decode())
        self.assertEqual(sent_body["model"], "llama3.2")
        self.assertFalse(sent_body["stream"])
        self.assertEqual(sent_body["messages"], [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "What is 2+2?"},
        ])

    def test_omits_system_message_when_empty(self):
        body = {"message": {"role": "assistant", "content": "pong"}}
        provider = OllamaProvider()

        with _mock_urlopen(_make_response(body)) as mock_open:
            result = provider.generate("llama3.2", "ping")

        self.assertEqual(result, "pong")
        req = mock_open.call_args[0][0]
        sent_body = json.loads(req.data.decode())
        self.assertEqual(len(sent_body["messages"]), 1)
        self.assertEqual(sent_body["messages"][0]["role"], "user")

    def test_connection_error_raises_model_connection_error(self):
        provider = OllamaProvider()

        with _mock_urlopen_raising(_make_url_error("Connection refused")):
            with self.assertRaises(ModelConnectionError) as ctx:
                provider.generate("llama3.2", "hello")

        self.assertIn("Connection refused", str(ctx.exception))

    def test_unexpected_response_shape_raises_model_connection_error(self):
        bad_body = {"unexpected": "shape"}
        provider = OllamaProvider()

        with _mock_urlopen(_make_response(bad_body)):
            with self.assertRaises(ModelConnectionError):
                provider.generate("llama3.2", "hello")

    def test_custom_base_url(self):
        body = {"message": {"role": "assistant", "content": "ok"}}
        provider = OllamaProvider(base_url="http://myhost:9999")

        with _mock_urlopen(_make_response(body)) as mock_open:
            provider.generate("llama3.2", "test")

        req = mock_open.call_args[0][0]
        self.assertEqual(req.full_url, "http://myhost:9999/api/chat")


# ---------------------------------------------------------------------------
# LMStudioProvider
# ---------------------------------------------------------------------------

class TestLMStudioProvider(unittest.TestCase):

    def test_happy_path_returns_choices_content(self):
        body = {
            "choices": [
                {"message": {"role": "assistant", "content": "Hi from LM Studio"}}
            ]
        }
        provider = LMStudioProvider()

        with _mock_urlopen(_make_response(body)) as mock_open:
            result = provider.generate("mistral", "Tell me a joke", "Be funny.")

        self.assertEqual(result, "Hi from LM Studio")
        mock_open.assert_called_once()

        req = mock_open.call_args[0][0]
        self.assertEqual(req.full_url, "http://localhost:1234/v1/chat/completions")
        self.assertEqual(req.get_method(), "POST")
        self.assertIn("Bearer local", req.get_header("Authorization"))

        sent_body = json.loads(req.data.decode())
        self.assertEqual(sent_body["model"], "mistral")
        self.assertEqual(sent_body["messages"], [
            {"role": "system", "content": "Be funny."},
            {"role": "user", "content": "Tell me a joke"},
        ])

    def test_omits_system_message_when_empty(self):
        body = {"choices": [{"message": {"role": "assistant", "content": "pong"}}]}
        provider = LMStudioProvider()

        with _mock_urlopen(_make_response(body)) as mock_open:
            provider.generate("mistral", "ping")

        req = mock_open.call_args[0][0]
        sent_body = json.loads(req.data.decode())
        self.assertEqual(len(sent_body["messages"]), 1)
        self.assertEqual(sent_body["messages"][0]["role"], "user")

    def test_connection_error_raises_model_connection_error(self):
        provider = LMStudioProvider()

        with _mock_urlopen_raising(_make_url_error("ECONNREFUSED")):
            with self.assertRaises(ModelConnectionError) as ctx:
                provider.generate("mistral", "hello")

        self.assertIn("ECONNREFUSED", str(ctx.exception))

    def test_unexpected_response_shape_raises_model_connection_error(self):
        bad_body = {"choices": []}
        provider = LMStudioProvider()

        with _mock_urlopen(_make_response(bad_body)):
            with self.assertRaises(ModelConnectionError):
                provider.generate("mistral", "hello")

    def test_custom_base_url_and_api_key(self):
        body = {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
        provider = LMStudioProvider(
            base_url="http://myhost:5678/v1",
            api_key="sk-secret",
        )

        with _mock_urlopen(_make_response(body)) as mock_open:
            provider.generate("mistral", "test")

        req = mock_open.call_args[0][0]
        self.assertEqual(req.full_url, "http://myhost:5678/v1/chat/completions")
        self.assertIn("Bearer sk-secret", req.get_header("Authorization"))


# ---------------------------------------------------------------------------
# oMLXProvider
# ---------------------------------------------------------------------------

class TestoMLXProvider(unittest.TestCase):

    def test_happy_path_returns_choices_content(self):
        body = {
            "choices": [
                {"message": {"role": "assistant", "content": "Hi from oMLX"}}
            ]
        }
        provider = oMLXProvider()

        with _mock_urlopen(_make_response(body)) as mock_open:
            result = provider.generate("llama3.2", "What is AI?", "Be concise.")

        self.assertEqual(result, "Hi from oMLX")
        mock_open.assert_called_once()

        req = mock_open.call_args[0][0]
        self.assertEqual(req.full_url, "http://localhost:8080/v1/chat/completions")
        self.assertEqual(req.get_method(), "POST")
        self.assertIn("Bearer local", req.get_header("Authorization"))

        sent_body = json.loads(req.data.decode())
        self.assertEqual(sent_body["model"], "llama3.2")
        self.assertEqual(sent_body["messages"], [
            {"role": "system", "content": "Be concise."},
            {"role": "user", "content": "What is AI?"},
        ])

    def test_omits_system_message_when_empty(self):
        body = {"choices": [{"message": {"role": "assistant", "content": "pong"}}]}
        provider = oMLXProvider()

        with _mock_urlopen(_make_response(body)) as mock_open:
            provider.generate("llama3.2", "ping")

        req = mock_open.call_args[0][0]
        sent_body = json.loads(req.data.decode())
        self.assertEqual(len(sent_body["messages"]), 1)
        self.assertEqual(sent_body["messages"][0]["role"], "user")

    def test_connection_error_raises_model_connection_error(self):
        provider = oMLXProvider()

        with _mock_urlopen_raising(_make_url_error("Connection timed out")):
            with self.assertRaises(ModelConnectionError) as ctx:
                provider.generate("llama3.2", "hello")

        self.assertIn("Connection timed out", str(ctx.exception))

    def test_unexpected_response_shape_raises_model_connection_error(self):
        bad_body = {"no_choices_key": True}
        provider = oMLXProvider()

        with _mock_urlopen(_make_response(bad_body)):
            with self.assertRaises(ModelConnectionError):
                provider.generate("llama3.2", "hello")

    def test_custom_base_url(self):
        body = {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
        provider = oMLXProvider(base_url="http://remotehost:4321/v1")

        with _mock_urlopen(_make_response(body)) as mock_open:
            provider.generate("llama3.2", "test")

        req = mock_open.call_args[0][0]
        self.assertEqual(req.full_url, "http://remotehost:4321/v1/chat/completions")


# ---------------------------------------------------------------------------
# get_provider factory
# ---------------------------------------------------------------------------

class TestGetProvider(unittest.TestCase):

    def setUp(self):
        # Isolate each test from whatever PARLIAMENT_PROVIDER is set in the env
        self._orig = os.environ.pop("PARLIAMENT_PROVIDER", None)

    def tearDown(self):
        if self._orig is not None:
            os.environ["PARLIAMENT_PROVIDER"] = self._orig
        else:
            os.environ.pop("PARLIAMENT_PROVIDER", None)

    def test_default_is_ollama(self):
        provider = get_provider()
        self.assertIsInstance(provider, OllamaProvider)

    def test_explicit_ollama(self):
        self.assertIsInstance(get_provider("ollama"), OllamaProvider)

    def test_explicit_lm_studio(self):
        self.assertIsInstance(get_provider("lm_studio"), LMStudioProvider)

    def test_explicit_omlx(self):
        self.assertIsInstance(get_provider("omlx"), oMLXProvider)

    def test_env_var_selects_lm_studio(self):
        os.environ["PARLIAMENT_PROVIDER"] = "lm_studio"
        self.assertIsInstance(get_provider(), LMStudioProvider)

    def test_env_var_selects_omlx(self):
        os.environ["PARLIAMENT_PROVIDER"] = "omlx"
        self.assertIsInstance(get_provider(), oMLXProvider)

    def test_explicit_arg_overrides_env_var(self):
        os.environ["PARLIAMENT_PROVIDER"] = "lm_studio"
        # Explicit arg takes precedence
        self.assertIsInstance(get_provider("ollama"), OllamaProvider)

    def test_unknown_provider_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            get_provider("nonexistent")
        self.assertIn("nonexistent", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
