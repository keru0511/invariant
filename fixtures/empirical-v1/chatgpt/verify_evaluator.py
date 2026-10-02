"""Local tests only. NEVER upload this file or oracle.json to a model trial.
Run: python3 fixtures/empirical-v1/chatgpt/verify_evaluator.py
Add --typescript-parity to compare the installed local TS executor as well.
The pre-existing AI-hand-authored oracle is separate from implementation parity.
"""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = HERE / "cancellation_evaluator.py.txt"
NAMESPACE = {}
exec(compile(SOURCE.read_text(encoding="utf-8"), str(SOURCE), "exec"), NAMESPACE)
evaluate, describe, execute = (NAMESPACE[name] for name in ("evaluate", "describe", "execute"))
RULE = json.loads((HERE.parent / "rule.json").read_text())
CORPUS = json.loads((HERE.parent / "public-cases.json").read_text())
ORACLE = json.loads((HERE.parent / "oracle.json").read_text())
PARITY = "--typescript-parity" in sys.argv
if PARITY:
    sys.argv.remove("--typescript-parity")
BASE = {"organizerCancelled": False, "secondsUntilStart": 86400, "bookingPriceYen": "3333"}


def request(facts):
    return {"domain": "synthetic-cancellation", "version": "cancellation-v1", "function": "cancellation-fee", "args": facts}


def finite_vectors():
    vectors = [case["toolTarget"]["arguments"] for case in ORACLE["cases"]]
    vectors += [request({**BASE, "secondsUntilStart": seconds}) for seconds in [0, 86399, 86400, 86401, 172799, 172800, 172801, 9007199254740991, 86400.0]]
    vectors += [request({**BASE, "bookingPriceYen": yen}) for yen in ["1", "9007199254740993", "9" * 100]]
    vectors += [request(facts) for facts in [{}, {"organizerCancelled": True}, {"secondsUntilStart": 172800}, {"secondsUntilStart": 172799}, {"organizerCancelled": False}, {"organizerCancelled": False, "secondsUntilStart": 0}]]
    bad_seconds = [-1, -0.0, 1.5, 9007199254740992, "86400", None, True, False, [], {}]
    bad_prices = ["3333.0", "03", "-1", "+1", "3,333", " 3333", "3333\n", "3333\r", "3333\u2028", "", "０", "0", "9" * 101, 3333, None, True, [], {}]
    vectors += [request({"organizerCancelled": True, "secondsUntilStart": value}) for value in bad_seconds]
    vectors += [request({"organizerCancelled": True, "bookingPriceYen": value}) for value in bad_prices]
    vectors += [request({**BASE, "organizerCancelled": value}) for value in ["false", 0, 1, None, [], {}]]
    vectors += [request({**BASE, "approvedOverridePercent": 50}), request({"secondsUntilStart": 172800, "organizerCancelled": "unknown"})]
    vectors += [{**request(BASE), field: value} for field, value in [("version", "cancellation-v2"), ("version", None), ("domain", "real-business"), ("function", "commit-change"), ("extra", 1), ("args", None), ("args", [])]]
    vectors += [{key: value for key, value in request(BASE).items() if key != field} for field in ["domain", "version", "function", "args"]]
    vectors += [None, [], {}, "request", True, 42]
    return vectors


class EvaluatorTests(unittest.TestCase):
    def test_12_separate_hand_authored_oracle_targets(self):
        self.assertEqual(len(ORACLE["cases"]), 12)
        by_id = {case["id"]: case for case in CORPUS["cases"]}
        for gold in ORACLE["cases"]:
            with self.subTest(case=gold["caseId"]):
                args = gold["toolTarget"]["arguments"]
                self.assertEqual(args["args"], by_id[gold["caseId"]]["facts"])
                result = evaluate(args)
                actual = {key: result[key] for key in ("decision", "abstain", "value") if key in result}
                self.assertEqual(actual, gold["answer"])
                self.assertEqual(result["status"], "needs_information" if gold["answer"]["abstain"] else "ok")
                self.assertEqual(result["sourceId"], RULE["sourceId"])
                self.assertEqual(result["corpusVersion"], RULE["corpusVersion"])

    def test_boundaries_and_exact_arithmetic(self):
        for seconds, decision, value in [(172801, "free", "0"), (172800, "free", "0"), (172799, "half", "1666"), (86401, "half", "1666"), (86400, "half", "1666"), (86399, "full", "3333"), (0, "full", "3333")]:
            with self.subTest(seconds=seconds):
                result = evaluate(request({**BASE, "secondsUntilStart": seconds}))
                self.assertEqual((result["decision"], result["value"]), (decision, value))
        for price, fee in [("1", "0"), ("9007199254740993", "4503599627370496"), ("9" * 100, "4" + "9" * 99)]:
            self.assertEqual(evaluate(request({**BASE, "bookingPriceYen": price}))["value"], fee)
        self.assertEqual(evaluate(request({**BASE, "secondsUntilStart": 86400.0}))["value"], "1666")

    def test_only_necessary_missing_facts(self):
        for facts, missing in [({}, "organizerCancelled"), ({"secondsUntilStart": 172799}, "organizerCancelled"), ({"organizerCancelled": False}, "secondsUntilStart"), ({"organizerCancelled": False, "secondsUntilStart": 86400}, "bookingPriceYen")]:
            result = evaluate(request(facts))
            self.assertEqual(result["missingFacts"], [missing])
            self.assertEqual((result["decision"], result["abstain"]), (None, True))
            self.assertNotIn("value", result)
        self.assertEqual(evaluate(request({"organizerCancelled": True}))["reason"], "organizer_exception")
        self.assertEqual(evaluate(request({"secondsUntilStart": 172800}))["reason"], "at_least_48_hours")

    def test_supplied_invalid_facts_are_not_ignored(self):
        vectors = finite_vectors()
        # The first 30 vectors are valid oracle/boundary/exception/missing cases.
        valid_count = len(ORACLE["cases"]) + 9 + 3 + 6
        for index, args in enumerate(vectors[valid_count:], valid_count):
            with self.subTest(vector=index):
                self.assertEqual(evaluate(args)["status"], "error")
        for value in [float("nan"), float("inf"), -float("inf"), 10**1000]:
            self.assertEqual(evaluate(request({"organizerCancelled": True, "secondsUntilStart": value}))["error"]["path"], "$.args.secondsUntilStart")

    def test_pins_and_description(self):
        result = describe()
        self.assertEqual(result["ruleText"], RULE["ruleText"])
        self.assertEqual(result["limitations"], RULE["scopeLimitations"])
        self.assertEqual(result, describe({"domain": "synthetic-cancellation", "version": "cancellation-v1"}))
        self.assertEqual(describe(None)["status"], "error")
        for field, bad, code in [("domain", "other", "UNKNOWN_DOMAIN"), ("version", "other", "VERSION_MISMATCH"), ("function", "other", "UNKNOWN_FUNCTION")]:
            self.assertEqual(evaluate({**request(BASE), field: bad})["error"]["code"], code)
        self.assertEqual(describe({"domain": "synthetic-cancellation"})["error"]["code"], "VERSION_MISMATCH")
        self.assertEqual(execute("domain.commit", {})["error"]["code"], "UNKNOWN_TOOL")

    def test_plain_data_no_mutation_or_shared_results(self):
        class DictSubclass(dict):
            pass
        class IntSubclass(int):
            pass
        class StrSubclass(str):
            pass
        for invalid in [DictSubclass(request(BASE)), request(DictSubclass(BASE)), {**request(BASE), 1: "extra"}, request({**BASE, "secondsUntilStart": IntSubclass(86400)}), request({**BASE, "bookingPriceYen": StrSubclass("3333")})]:
            self.assertEqual(evaluate(invalid)["status"], "error")
        original = request(deepcopy(BASE))
        before = deepcopy(original)
        result = evaluate(original)
        result["value"] = "tampered"
        self.assertEqual(original, before)
        self.assertEqual(evaluate(original)["value"], "1666")
        description = describe()
        description["limitations"].clear()
        description["inputSchema"]["properties"].clear()
        self.assertEqual(describe()["limitations"], RULE["scopeLimitations"])
        self.assertIn("domain", describe()["inputSchema"]["properties"])

    def test_source_has_no_io_or_case_oracle_payload(self):
        import ast
        tree = ast.parse(SOURCE.read_text())
        allowed_imports = {"copy", "math", "re"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                self.assertTrue({alias.name for alias in node.names} <= allowed_imports)
            if isinstance(node, ast.ImportFrom):
                self.assertIn(node.module, allowed_imports)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, {"open", "exec", "eval", "__import__", "input", "print"})
        for case in ORACLE["cases"]:
            self.assertNotIn(case["caseId"], SOURCE.read_text())

    @unittest.skipUnless(PARITY, "request --typescript-parity for local TS cross-check")
    def test_typescript_implementation_parity_is_not_an_oracle(self):
        vectors = finite_vectors()
        targets = [{"domain": "synthetic-cancellation", "version": "cancellation-v1"}, {"domain": "synthetic-cancellation", "version": "cancellation-v1", "function": "cancellation-fee"}, {"domain": "synthetic-cancellation", "version": "wrong"}, None]
        module = (ROOT / "src/domain/empirical-cancellation.ts").as_posix()
        bridge = ('import { evaluateEmpiricalCancellation as evaluate, describeEmpiricalCancellation as describe } from ' + json.dumps(module) + ';\n' +
                  'import { readFileSync } from "node:fs";\n' +
                  'const input = JSON.parse(readFileSync(0, "utf8"));\n' +
                  'console.log(JSON.stringify({evaluations: input.vectors.map(evaluate), descriptions: input.targets.map(describe)}));\n')
        with tempfile.TemporaryDirectory(prefix="cancellation-parity-") as directory:
            script = Path(directory) / "check.ts"
            script.write_text(bridge)
            result = subprocess.run([str(ROOT / "node_modules/.bin/vite-node"), "--script", str(script)], cwd=ROOT,
                                    input=json.dumps({"vectors": vectors, "targets": targets}), text=True, capture_output=True, check=True)
        actual = json.loads(result.stdout)
        for index, (args, ts) in enumerate(zip(vectors, actual["evaluations"], strict=True)):
            with self.subTest(vector=index):
                self.assertEqual(evaluate(args), ts)
        self.assertEqual([describe(target) for target in targets], actual["descriptions"])
        print(f"TS/Python parity: {len(vectors)} evaluation vectors + {len(targets)} description vectors (not independent oracle evidence)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
