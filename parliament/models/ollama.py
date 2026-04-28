from __future__ import annotations

import requests

OLLAMA_BASE_URL = "http://localhost:11434"


class OllamaModel:
    def __init__(self, model_name: str, base_url: str = OLLAMA_BASE_URL) -> None:
        self.model_name = model_name
        self._url = f"{base_url}/api/generate"

    def generate(self, prompt: str) -> str:
        payload = {
            "model": self.model_name,
            "prompt": prompt,
            "stream": False,
        }
        response = requests.post(self._url, json=payload, timeout=120)
        response.raise_for_status()
        return response.json()["response"].strip()
