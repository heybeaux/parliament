#!/usr/bin/env python3
"""Wire up agents and run a single debate."""
from __future__ import annotations

import textwrap

from parliament.agents.proposer import Proposer
from parliament.agents.skeptic import Skeptic
from parliament.agents.synthesizer import Synthesizer
from parliament.agents.sentry import Sentry
from parliament.orchestrator import Orchestrator

TOPIC = "Should AI systems have legal personhood?"


def print_turn(agent: str, neurotype: str, content: str) -> None:
    wrapped = textwrap.fill(content, width=80, subsequent_indent="    ")
    print(f"\n[{agent} / {neurotype}]\n    {wrapped}")


def main() -> None:
    proposer = Proposer(model_name="llama3.2")
    skeptic = Skeptic(model_name="mistral", name="Skeptic", neurotype="critic")
    synthesizer = Synthesizer(model_name="qwen2.5")
    red_agent = Skeptic(
        model_name="mistral-openorca",
        name="RedAgent",
        neurotype="adversarial",
        role_hint=(
            "You are a red agent. Disrupt any emerging consensus by surfacing the "
            "strongest possible objection that has NOT yet been raised. Be blunt."
        ),
    )
    sentry = Sentry(model_name="tinyllama")

    orchestrator = Orchestrator(
        proposer=proposer,
        skeptic=skeptic,
        synthesizer=synthesizer,
        red_agent=red_agent,
        sentry=sentry,
    )

    print(f"=== Nexus Parliament ===\nTopic: {TOPIC}\n")

    blackboard = orchestrator.run(TOPIC, max_rounds=10)

    print("\n\n=== Transcript ===")
    for turn in blackboard.turns:
        print_turn(turn["agent"], turn["neurotype"], turn["content"])

    print("\n\n=== Outcome ===")
    if blackboard.resolved:
        print("Status: RESOLVED")
    else:
        print("Status: UNRESOLVED — Residue of Conflict captured")
        if blackboard.residue:
            print(f"Residue: {blackboard.residue}")

    if "sentry_halt" in blackboard.metadata:
        print(f"Sentry halted debate: {blackboard.metadata['sentry_halt']}")


if __name__ == "__main__":
    main()
