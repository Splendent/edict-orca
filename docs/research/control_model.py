"""Bounded model of Edict control decisions, not an Orca implementation."""
from copy import deepcopy
from dataclasses import dataclass, field
from itertools import permutations
import json


@dataclass
class Model:
    mode: str
    sequence: int = 0
    control_at: int | None = None
    blocked: bool = False
    operation: str = "none"
    admitted_at: int | None = None
    physical_send_at: int | None = None
    send_count: int = 0
    receipt_archived: bool = False
    possible_live_effects: bool = False
    history: list[str] = field(default_factory=list)

    def step(self, action: str) -> None:
        self.sequence += 1
        self.history.append(action)
        if action == "reserve":
            if not self.blocked and self.operation == "none":
                self.operation = "reserved"
        elif action == "admit":
            # This is a local durable decision, not native acceptance.
            if not self.blocked and self.operation == "reserved":
                self.admitted_at = self.sequence
                self.operation = "admitted"
                # A crash after this durable decision cannot prove no native work.
                self.possible_live_effects = True
        elif action == "send":
            # An earlier admission may physically send after control commits.
            if self.operation == "admitted":
                self.operation = "submitted"
                self.send_count += 1
                self.physical_send_at = self.sequence
        elif action == "control":
            self.blocked = True
            self.control_at = self.sequence
            if self.operation == "reserved":
                self.operation = "withdrawn"
        elif action == "receipt":
            if self.operation in {"submitted", "unknown"} and self.send_count:
                self.receipt_archived = True
                self.operation = "request-resolved"
                # This is an acceptance receipt, not execution termination proof.
        elif action == "crash":
            # Persistent decisions survive, but external acceptance is uncertain.
            restored = deepcopy(self)
            if restored.operation in {"admitted", "submitted"}:
                restored.operation = "unknown"
            self.__dict__.update(restored.__dict__)
        else:
            raise AssertionError(action)
        self.check()

    def check(self) -> None:
        assert self.send_count <= 1
        if self.control_at is not None and self.admitted_at is not None:
            assert self.admitted_at < self.control_at
        if self.operation == "unknown":
            assert not self.cancel_settled()
        if self.receipt_archived:
            assert self.send_count == 1
            assert self.possible_live_effects
            assert not self.cancel_settled()

    def cancel_settled(self) -> bool:
        # Native execution ending and resource release are outside this model.
        # Only a never-admitted operation can be proved harmless here.
        return (self.mode == "cancel" and self.blocked
                and not self.possible_live_effects
                and self.operation in {"none", "withdrawn"})


def schedules():
    actions = ("reserve", "admit", "send", "receipt", "control", "crash")
    for order in permutations(actions):
        positions = [order.index(x) for x in actions[:4]]
        if positions == sorted(positions):
            yield order


def run():
    examined = 0
    physical_after_control = []
    unknown_cases = 0
    for mode in ("pause", "off", "cancel"):
        for order in schedules():
            state = Model(mode)
            for action in order:
                state.step(action)
                if state.operation == "unknown":
                    unknown_cases += 1
            examined += 1
            if (state.physical_send_at is not None and state.control_at is not None
                    and state.physical_send_at > state.control_at):
                physical_after_control.append({"mode": mode, "trace": order})

    assert physical_after_control, "The model must expose the RPC boundary limit"
    assert unknown_cases, "Unknown external effects must remain represented"

    # Reproduce the reviewer's trace through the real abstract transitions.
    accepted_after_cancel = Model("cancel")
    for action in ("reserve", "admit", "send", "control", "receipt"):
        accepted_after_cancel.step(action)
    assert accepted_after_cancel.receipt_archived
    assert not accepted_after_cancel.cancel_settled()

    # Neither duplicate sends nor recovery from unknown may start another call.
    unknown = Model("cancel")
    for action in ("reserve", "admit", "send", "crash", "send", "control"):
        unknown.step(action)
    assert unknown.send_count == 1
    assert unknown.operation == "unknown"
    assert not unknown.cancel_settled()

    report = {
        "scope": "bounded abstract model; no native runtime or filesystem effects",
        "status": "PASS",
        "interleavings_examined": examined,
        "invariants": [
            "no local admission after a blocking control decision",
            "uncertain native effects prevent claiming cancellation settled",
            "an acceptance receipt does not prove execution or cancellation finished",
            "duplicate send actions and unknown recovery do not make another call"
        ],
        "strict_no_physical_send_after_control": "NOT GUARANTEED",
        "counterexample": physical_after_control[0],
        "unknown_state_observations": unknown_cases,
        "limitations": [
            "serialization and atomic persistence are assumptions, not tested code",
            "no proof of native request ID availability or deduplication",
            "no validation of OS processes, provider turns, IPC, or native stopping",
            "crashes are modeled around one operation, not arbitrary disk corruption",
            "no model of multi-item isolation, generations, resume, or domain Done"
        ]
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    run()
