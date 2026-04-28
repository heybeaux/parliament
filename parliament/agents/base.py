from __future__ import annotations

from abc import ABC, abstractmethod

from parliament.blackboard import Blackboard


WORD_CAP = 100


def _build_history_block(blackboard: Blackboard, last_n: int = 6) -> str:
    lines = []
    for t in blackboard.last_n_turns(last_n):
        lines.append(f"[{t['agent']} / {t['neurotype']}]: {t['content']}")
    return "\n".join(lines)


class BaseAgent(ABC):
    def __init__(self, name: str, neurotype: str, model_name: str) -> None:
        self.name = name
        self.neurotype = neurotype
        self.model_name = model_name

    def build_prompt(self, blackboard: Blackboard) -> str:
        history = _build_history_block(blackboard)
        return (
            f"Topic: {blackboard.topic}\n\n"
            f"Recent debate:\n{history}\n\n"
            f"You are {self.name} ({self.neurotype}). "
            f"Respond in {WORD_CAP} words or fewer. Do not exceed this limit."
        )

    @abstractmethod
    def generate(self, blackboard: Blackboard) -> str: ...
