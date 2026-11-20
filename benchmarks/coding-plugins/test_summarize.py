import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


class SummarizeTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {
                "arm": arm, "task": task, "attempt": attempt,
                "verifier_pass": task == "first" or arm == "control",
                "timed_out": arm == "control" and task == "second",
                "cost_usd": 0.20 if arm == "control" else 0.15,
                "elapsed_seconds": attempt + (10 if task == "second" else 0),
            }
            for arm in ("control", "preview")
            for task in ("first", "second")
            for attempt in (1, 2)
        ]

    def run_cli(self):
        with TemporaryDirectory() as directory:
            trials = Path(directory) / "trials.jsonl"
            trials.write_text("\n".join(map(json.dumps, self.rows)), encoding="utf-8")
            return subprocess.run([
                sys.executable, str(Path(__file__).with_name("summarize.py")), str(trials),
                "--baseline", "control", "--resamples", "100", "--seed", "7",
            ], capture_output=True, text=True, timeout=15)

    def test_summarizes_paired_trials(self):
        completed = self.run_cli()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        report = json.loads(completed.stdout)
        self.assertEqual(report["tasks"], 2)
        self.assertEqual(report["attempts_per_task"], 2)
        self.assertEqual(report["arms"]["control"], {
            "pass_rate": 0.5, "timeout_rate": 0.5, "usd_per_task": 0.2,
            "usd_per_pass": 0.4, "trials": 4, "priced_trials": 4,
            "median_seconds": 6.5, "p95_seconds": 12,
        })
        deltas = report["arm_minus_baseline"]["preview"]
        self.assertEqual(deltas["pass_rate"]["ci95"], [0, 0])
        self.assertAlmostEqual(deltas["usd_per_pass"]["estimate"], -0.10)
        self.assertIsNone(deltas["usd_per_pass"]["ci95"])

    def test_missing_price_keeps_cost_unknown_and_rates_complete(self):
        self.rows[-1]["cost_usd"] = None
        completed = self.run_cli()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        report = json.loads(completed.stdout)
        preview = report["arms"]["preview"]
        self.assertEqual(preview["priced_trials"], 3)
        self.assertEqual(preview["pass_rate"], 0.5)
        self.assertIsNone(preview["usd_per_task"])
        self.assertIsNone(preview["usd_per_pass"])
        self.assertEqual(report["arm_minus_baseline"]["preview"]["usd_per_task"], {
            "estimate": None, "ci95": None, "defined_resamples": 0,
        })

    def test_rejects_missing_duplicate_and_invalid_trials(self):
        last = self.rows.pop()
        self.assertIn("missing arm/task/attempt", self.run_cli().stderr)
        self.rows.extend([last, last])
        self.assertIn("duplicate arm/task/attempt", self.run_cli().stderr)
        self.rows.pop()
        last["verifier_pass"] = 1
        self.assertIn("invalid verifier_pass", self.run_cli().stderr)


if __name__ == "__main__":
    unittest.main()
