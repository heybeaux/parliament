from __future__ import annotations

from parliament.blackboard import Blackboard
from parliament.models.ollama import OllamaModel

from .base import BaseAgent


class Proposer(BaseAgent):
    def __init__(self, model_name: str = "llama3.2") -> None:
        super().__init__(name="Proposer", neurotype="advocate", model_name=model_name)
        self._model = OllamaModel(model_name)

    def generate(self, blackboard: Blackboard) -> str:
        prompt = self.build_prompt(blackboard) + (
            "\n\nAdvance a clear, concrete position on the topic. "
            "If you have spoken before, develop or defend your prior stance."
        )
        return self._model.generate(prompt)
