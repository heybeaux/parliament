from __future__ import annotations

from parliament.agents.base import BaseAgent
from parliament.agents.sentry import Sentry
from parliament.blackboard import Blackboard

RED_AGENT_INTERVAL = 3  # inject red agent every N turns


class Orchestrator:
    def __init__(
        self,
        proposer: BaseAgent,
        skeptic: BaseAgent,
        synthesizer: BaseAgent,
        red_agent: BaseAgent,
        sentry: Sentry,
    ) -> None:
        self.proposer = proposer
        self.skeptic = skeptic
        self.synthesizer = synthesizer
        self.red_agent = red_agent
        self.sentry = sentry

    def _record(self, agent: BaseAgent, blackboard: Blackboard) -> str:
        content = agent.generate(blackboard)
        blackboard.add_turn(agent.name, agent.neurotype, content)
        return content

    def run(self, topic: str, max_rounds: int = 10) -> Blackboard:
        blackboard = Blackboard(topic=topic)
        cycle = [self.proposer, self.skeptic, self.synthesizer]
        turn_count = 0

        for round_num in range(max_rounds):
            for agent in cycle:
                # Inject red agent before each synthesizer turn on interval
                if turn_count > 0 and turn_count % RED_AGENT_INTERVAL == 0:
                    self._record(self.red_agent, blackboard)

                self._record(agent, blackboard)
                turn_count += 1

                if agent is self.synthesizer:
                    result = self.sentry.check(blackboard)
                    if result.converged:
                        blackboard.metadata["sentry_halt"] = result.reason
                        # Last synthesizer content becomes the residue
                        blackboard.residue = blackboard.turns[-1]["content"]
                        blackboard.resolved = False
                        return blackboard

        # Natural end: mark resolved only if no outstanding conflicts
        if not blackboard.conflicts:
            blackboard.resolved = True
        else:
            blackboard.residue = "; ".join(blackboard.conflicts)

        return blackboard
