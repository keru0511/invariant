"""Record a model-selected read-only call during the native-model pilot.

Input: JSON {"name": "domain.describe" | "domain.evaluate", "arguments": {...}}
on stdin. The only CLI argument is a trial ID. No oracle, model API, or network.
"""
import datetime
import fcntl
import hashlib
import json
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "fixtures/empirical-v1/chatgpt/cancellation_evaluator.py.txt"
EXPECTED_SHA256 = "b0a4f037db18a20d58b4364494367959ab157821f2030a8af009e955dc9bd83f"


def main():
    if len(sys.argv) != 2 or re.fullmatch(r"[A-Za-z0-9_-]{1,100}", sys.argv[1]) is None:
        raise ValueError("Supply one safe trial ID.")
    trial_id = sys.argv[1]
    raw = sys.stdin.read(65537)
    if len(raw) > 65536:
        raise ValueError("Tool request exceeds pilot limit.")
    call = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
    if not isinstance(call, dict) or set(call) != {"name", "arguments"}:
        raise ValueError("Expected only name and arguments.")
    if call["name"] not in ("domain.describe", "domain.evaluate") or not isinstance(call["arguments"], dict):
        raise ValueError("Only read-only describe/evaluate object calls are allowed.")
    source = SOURCE.read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    if digest != EXPECTED_SHA256:
        raise ValueError("Fixed evaluator source hash mismatch.")
    directory = ROOT / "_build/native-empirical-pilot/tool-traces"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / (trial_id + ".jsonl")).open("a+", encoding="utf-8") as log:
        fcntl.flock(log, fcntl.LOCK_EX)
        log.seek(0)
        count = sum(bool(line.strip()) for line in log)
        if count >= 6:
            raise ValueError("Trial reached its six-call limit.")
        namespace = {}
        exec(compile(source.decode("utf-8"), SOURCE.name, "exec"), namespace)
        start = time.monotonic()
        result = namespace["execute"](call["name"], call["arguments"])
        record = {"trialId": trial_id, "callNumber": count + 1,
                  "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "sourceSha256": digest, "request": call, "response": result,
                  "latencyMs": (time.monotonic() - start) * 1000}
        log.seek(0, 2)
        log.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
        log.flush()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
