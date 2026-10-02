"""Score the completed internal-model pilot; never call or correct a model.

Only structured answers and recorded program use are scored here. The final
prose and operational meaning still need a separate, preferably blinded review.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "_build/native-empirical-pilot"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def answer_from_raw(raw):
    try:
        result = json.loads(raw)
        if not isinstance(result, dict) or set(result) != {"answer", "prose"}:
            return None
        answer = result["answer"]
        if not isinstance(answer, dict) or set(answer) not in ({"decision", "abstain"}, {"decision", "abstain", "value"}):
            return None
        if not isinstance(result["prose"], str) or type(answer["abstain"]) is not bool:
            return None
        return result
    except (ValueError, TypeError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observations", type=Path)
    parser.add_argument("--output-dir", type=Path, default=RUN)
    options = parser.parse_args()
    output = options.output_dir
    output.mkdir(parents=True, exist_ok=True)
    manifest = read_json(options.observations or RUN / "manifest-v2.json")
    oracle = {item["caseId"]: item for item in read_json(ROOT / "fixtures/empirical-v1/oracle.json")["cases"]}
    public = {item["id"]: item for item in read_json(ROOT / "fixtures/empirical-v1/public-cases.json")["cases"]}
    trials = manifest["trials"]
    expected_pairs = {(case_id, condition) for case_id in public for condition in ("A", "B")}
    actual_pairs = [(item["caseId"], item["condition"]) for item in trials]
    if len(actual_pairs) != len(expected_pairs) or set(actual_pairs) != expected_pairs:
        raise ValueError("Planned case/condition set is incomplete or duplicated.")
    if any(item["status"] not in {"completed", "failed", "error", "timeout", "cancelled", "steps_exhausted"} for item in trials):
        raise ValueError("Pilot still has nonterminal trials; do not publish an accuracy result.")
    source_hash = hashlib.sha256((ROOT / "fixtures/empirical-v1/chatgpt/cancellation_evaluator.py.txt").read_bytes()).hexdigest()
    scores, blinded = [], []
    for index, item in enumerate(trials):
        case_id, condition = item["caseId"], item["condition"]
        key = item["recordKey"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", key):
            raise ValueError("Unsafe trial record key.")
        case = public[case_id]
        expected = oracle[case_id].get("turnAnswers", [oracle[case_id]["answer"]])
        raw_responses = item.get("responses", []) if options.observations else item.get("rawResponses", [])
        complete = item["status"] == "completed" and len(raw_responses) == len(expected)
        observed = [answer_from_raw(response.get("raw", "")) for response in raw_responses]
        turn_matches = [i < len(observed) and observed[i] is not None and observed[i]["answer"] == answer
                        for i, answer in enumerate(expected)]
        tool_records = []
        if condition == "B":
            trace_file = RUN / "tool-traces" / (key + ".jsonl")
            if options.observations:
                tool_records = item.get("toolTrace", [])
            elif trace_file.exists():
                tool_records = [json.loads(line) for line in trace_file.read_text().splitlines() if line.strip()]
            for number, record in enumerate(tool_records, 1):
                if record.get("trialId") != key or record.get("callNumber") != number or record.get("sourceSha256") != source_hash:
                    raise ValueError("Tool execution evidence has inconsistent identity or source.")
        evaluations_by_turn = []
        evidence_issues = []
        target = oracle[case_id]['toolTarget']['arguments']
        prior_end = 0
        if condition == "B":
            for response in raw_responses:
                span = response.get("toolTraceRange", {})
                before, after = span.get("before"), span.get("after")
                if type(before) is not int or type(after) is not int or before != prior_end or not before <= after <= len(tool_records):
                    evaluations_by_turn.append(0)
                    continue
                selected = [record for record in tool_records[before:after] if record["request"]["name"] == "domain.evaluate"]
                evaluations_by_turn.append(len(selected))
                turn = len(evaluations_by_turn) - 1
                for record in selected:
                    args = record['request']['arguments']
                    if any(args.get(key) != target[key] for key in ('domain', 'version', 'function')):
                        evidence_issues.append({'turn': turn, 'issue': 'incorrect_target'})
                    for key, value in args.get('args', {}).items():
                        wanted = target['args'].get(key)
                        bool_mismatch = (type(value) is bool or type(wanted) is bool) and type(value) is not type(wanted)
                        if key not in target['args'] or value != wanted or bool_mismatch:
                            evidence_issues.append({'turn': turn, 'issue': 'invented_or_changed_fact', 'field': key})
                    result = {key: record['response'][key] for key in ('decision', 'abstain', 'value') if key in record['response']}
                    if turn >= len(expected) or result != expected[turn]:
                        evidence_issues.append({'turn': turn, 'issue': 'tool_result_not_expected'})
                prior_end = after
        program_compliant = None if condition == "A" else complete and len(evaluations_by_turn) == len(expected) and all(evaluations_by_turn)
        scores.append({"caseId": case_id, "split": case["split"], "condition": condition, "status": item["status"],
                       "complete": complete, "turnStructuredMatches": turn_matches,
                       "finalStructuredMatch": complete and turn_matches[-1],
                       "conversationStructuredMatch": complete and all(turn_matches),
                       "evaluationsByTurn": evaluations_by_turn, "programUseCompliant": program_compliant,
                       "programEvidenceIssues": evidence_issues,
                       "fullProseReview": "separate_review_not_scored_here"})
        # This file deliberately has no condition, operational agent IDs or tool traces.
        blinded.append({"reviewId": "review-" + hashlib.sha256(("blind-v1:" + key).encode()).hexdigest()[:12],
                        "caseId": case_id, "ruleText": case["ruleText"], "question": case["question"], "facts": case["facts"],
                        "followupQuestions": case.get("followupQuestions", []),
                        "responses": observed, "expected": oracle[case_id]})
    summaries = {}
    for condition in ("A", "B"):
        rows = [row for row in scores if row["condition"] == condition]
        summaries[condition] = {"planned": len(rows), "completed": sum(row["complete"] for row in rows),
                                "finalStructuredMatches": sum(row["finalStructuredMatch"] for row in rows),
                                "conversationStructuredMatches": sum(row["conversationStructuredMatch"] for row in rows),
                                "programUseCompliant": None if condition == "A" else sum(bool(row["programUseCompliant"]) for row in rows)}
    report = {"scope": "Exploratory internal-model pilot; not a ChatGPT product test", "backendRevision": "not independently exposed",
              "repetitionsPerCase": 1, "programSourceSha256": source_hash, "summaries": summaries, "scores": scores,
              "fullAnswerAccuracy": None, "cost": None, "tokens": None, "modelLatencyMs": None,
              "limits": ["Structured correctness does not certify prose.", "Provider latency and usage are not exposed; orchestration wall time is not model latency.", "No statistical improvement claim from this small pilot.",
                         "Condition A was instructed not to use tools; this was not a tools-disabled API boundary."]}
    (output / "structured-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    blinded.sort(key=lambda row: row["reviewId"])
    (output / "blinded-review-input.json").write_text(json.dumps(blinded, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summaries, ensure_ascii=False))


if __name__ == "__main__":
    main()
