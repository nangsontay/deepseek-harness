"""Summarize paired coding-plugin trials from an existing evaluator."""
import argparse
from collections import defaultdict
from itertools import product
import json
import math
from pathlib import Path
import random
from statistics import fmean, median


def nonnegative_number(value):
    return type(value) in (int, float) and value >= 0 and math.isfinite(value)


def read_trials(path):
    trials = {}
    checks = {
        "task": lambda v: isinstance(v, str) and bool(v.strip()),
        "arm": lambda v: isinstance(v, str) and bool(v.strip()),
        "attempt": lambda v: type(v) is int and v >= 0,
        "verifier_pass": lambda v: type(v) is bool,
        "timed_out": lambda v: type(v) is bool,
        "cost_usd": lambda v: v is None or nonnegative_number(v),
        "elapsed_seconds": nonnegative_number,
    }
    with path.open(encoding="utf-8") as lines:
        for number, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                trial = json.loads(line)
            except ValueError as error:
                raise ValueError(f"line {number}: {error}") from error
            for field, valid in checks.items():
                if not isinstance(trial, dict) or field not in trial or not valid(trial[field]):
                    raise ValueError(f"line {number}: missing or invalid {field}")
            key = (trial["arm"], trial["task"], trial["attempt"])
            if key in trials:
                raise ValueError(f"line {number}: duplicate arm/task/attempt {key}")
            trials[key] = trial
    return trials


def percentile(ordered, fraction):
    return ordered[math.ceil(len(ordered) * fraction) - 1]


def rates(cells):
    passed = fmean(cell["pass_rate"] for cell in cells)
    timeout = fmean(cell["timeout_rate"] for cell in cells)
    costs = [cell["usd_per_task"] for cell in cells]
    cost = fmean(costs) if None not in costs else None
    return {
        "pass_rate": passed, "timeout_rate": timeout, "usd_per_task": cost,
        "usd_per_pass": None if cost is None or passed == 0 else cost / passed,
    }


def summarize(trials, baseline, resamples=10_000, seed=261119):
    arms, tasks, attempts = [sorted(set(column)) for column in zip(*trials)] if trials else ([], [], [])
    if len(arms) < 2 or baseline not in arms:
        raise ValueError("at least two arms are required, including the specified baseline")
    for key in product(arms, tasks, attempts):
        if key not in trials:
            raise ValueError(f"missing arm/task/attempt {key}")
    summaries, cells = {}, {}
    for arm in arms:
        cells[arm] = []
        elapsed, priced = [], 0
        for task in tasks:
            rows = [trials[arm, task, attempt] for attempt in attempts]
            costs = [row["cost_usd"] for row in rows if row["cost_usd"] is not None]
            priced += len(costs)
            elapsed.extend(row["elapsed_seconds"] for row in rows)
            cells[arm].append({
                "pass_rate": fmean(row["verifier_pass"] and not row["timed_out"] for row in rows),
                "timeout_rate": fmean(row["timed_out"] for row in rows),
                "usd_per_task": fmean(costs) if len(costs) == len(rows) else None,
            })
        summaries[arm] = {
            **rates(cells[arm]), "trials": len(elapsed), "priced_trials": priced,
            "median_seconds": median(elapsed), "p95_seconds": percentile(sorted(elapsed), .95),
        }

    variants = [arm for arm in arms if arm != baseline]
    rng = random.Random(seed)
    samples = defaultdict(list)
    for _ in range(resamples):
        picked = rng.choices(range(len(tasks)), k=len(tasks))
        draws = {arm: rates([cells[arm][index] for index in picked]) for arm in arms}
        for arm in variants:
            for metric, value in draws[arm].items():
                control = draws[baseline][metric]
                if value is not None and control is not None:
                    samples[arm, metric].append(value - control)

    differences = {}
    for arm in variants:
        differences[arm] = {}
        for metric in rates(cells[arm]):
            value, control = summaries[arm][metric], summaries[baseline][metric]
            delta = None if value is None or control is None else value - control
            # Resampling an entirely priced subset cannot rescue unknown overall cost.
            ordered = sorted(samples[arm, metric]) if delta is not None else []
            differences[arm][metric] = {
                "estimate": delta,
                "ci95": [percentile(ordered, q) for q in (.025, .975)] if len(ordered) == resamples else None,
                "defined_resamples": len(ordered),
            }
    return {
        "baseline": baseline, "tasks": len(tasks), "attempts_per_task": len(attempts),
        "seed": seed, "resamples": resamples, "arms": summaries, "arm_minus_baseline": differences,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "JSONL fields: task, arm (strings); attempt (integer); verifier_pass, timed_out "
        "(booleans); cost_usd (number or null); elapsed_seconds (number). Include all attempts "
        "for every task and arm. Timeouts count as failures. Cost metrics require complete pricing. "
        "Deltas are arm minus baseline in metric units; undefined estimates or intervals are null."
    ))
    parser.add_argument("trials", type=Path)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--resamples", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=261119)
    args = parser.parse_args()
    if args.resamples < 1:
        parser.error("--resamples must be positive")
    try:
        report = summarize(read_trials(args.trials), args.baseline, args.resamples, args.seed)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
