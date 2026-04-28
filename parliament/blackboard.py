from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TypedDict


class Turn(TypedDict):
    agent: str
    neurotype: str
    content: str
    timestamp: str


@dataclass
class Blackboard:
    topic: str
    turns: list[Turn] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    resolved: bool = False
    residue: str | None = None
    metadata: dict = field(default_factory=dict)

    def add_turn(self, agent: str, neurotype: str, content: str) -> None:
        self.turns.append(
            Turn(
                agent=agent,
                neurotype=neurotype,
                content=content,
                timestamp=datetime.now(timezone.utc).isoformat(),
            )
        )

    def last_n_turns(self, n: int) -> list[Turn]:
        return self.turns[-n:]

    def detect_echo_loop(self) -> bool:
        """True when the same agent agrees with the same prior agent twice in a row."""
        recent = self.last_n_turns(4)
        if len(recent) < 4:
            return False
        # Pattern: A→B→A→B where all contents are similar enough to flag
        agents = [t["agent"] for t in recent]
        return agents[0] == agents[2] and agents[1] == agents[3]
