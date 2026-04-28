import json
import urllib.error
import urllib.request

from .base import BaseModelProvider
from .errors import ModelConnectionError


class OllamaProvider(BaseModelProvider):
    """Provider that calls a local Ollama instance.

    Default endpoint: http://localhost:11434/api/chat
    Ollama's /api/chat response shape: {"message": {"role": "...", "content": "..."}}
    """

    def __init__(self, base_url: str = "http://localhost:11434") -> None:
        self._base_url = base_url.rstrip("/")

    def generate(self, model: str, prompt: str, system: str = "") -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = json.dumps(
            {"model": model, "messages": messages, "stream": False}
        ).encode()

        req = urllib.request.Request(
            url=f"{self._base_url}/api/chat",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )

        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode())
        except urllib.error.URLError as exc:
            raise ModelConnectionError(
                f"Ollama connection failed: {exc.reason}"
            ) from exc
        except Exception as exc:
            raise ModelConnectionError(
                f"Ollama request error: {exc}"
            ) from exc

        try:
            return body["message"]["content"]
        except (KeyError, TypeError) as exc:
            raise ModelConnectionError(
                f"Unexpected Ollama response shape: {body!r}"
            ) from exc
