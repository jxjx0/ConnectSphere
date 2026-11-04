"""Summarize existing pytest reports without changing the test or coverage result."""

import os
from pathlib import Path
import xml.etree.ElementTree as ET


def read_test_counts(path: Path) -> tuple[int, int, int, int]:
    root = ET.parse(path).getroot()
    # Use leaf suites so nested JUnit summaries are not counted twice.
    suites = [suite for suite in root.iter("testsuite") if suite.find("testsuite") is None]
    if not suites:
        raise ValueError("No test suites found")

    passed = failed = errors = skipped = 0
    for suite in suites:
        tests, failures, suite_errors, suite_skipped = (
            int(suite.attrib[name]) for name in ("tests", "failures", "errors", "skipped")
        )
        if min(tests, failures, suite_errors, suite_skipped) < 0:
            raise ValueError("Negative test count")
        suite_passed = tests - failures - suite_errors - suite_skipped
        if suite_passed < 0:
            raise ValueError("Inconsistent test counts")
        passed += suite_passed
        failed += failures
        errors += suite_errors
        skipped += suite_skipped
    return passed, failed, errors, skipped


def read_coverage_counts(path: Path) -> tuple[int, int]:
    root = ET.parse(path).getroot()
    if root.tag != "coverage":
        raise ValueError("Not a coverage report")
    covered = int(root.attrib["lines-covered"])
    total = int(root.attrib["lines-valid"])
    if total <= 0 or not 0 <= covered <= total:
        raise ValueError("Invalid coverage counts")
    return covered, total


def build_summary(backend: Path, outcome: str, test_url: str, coverage_url: str) -> str:
    status = {
        "success": "Passed",
        "failure": "Failed",
        "cancelled": "Cancelled",
        "skipped": "Not run",
    }.get(outcome, "Unknown")

    reports = backend / ".reports"
    try:
        passed, failed, errors, skipped = read_test_counts(reports / "test-results.xml")
        if failed or errors:
            status = "Failed"
        tests_text = f"- Tests: {passed} passed, {failed} failed, {errors} errors, {skipped} skipped"
    except (OSError, ET.ParseError, KeyError, ValueError):
        tests_text = "- Test results unavailable (report missing, unreadable, or malformed)."
        if status == "Passed":
            status = "Unknown (pytest succeeded, but test results are unavailable)"

    lines = ["## Backend Test Summary", "", f"- Test status: {status}", tests_text]
    try:
        covered, total = read_coverage_counts(reports / "coverage.xml")
        lines.extend([
            f"- Python line coverage: {100 * covered / total:.2f}%",
            f"- Covered lines / total executable lines: {covered} / {total}",
        ])
        if status == "Failed":
            lines.extend(["", "Coverage shown above comes from a failed test run."])
        elif status != "Passed":
            lines.extend(["", "Coverage shown above comes from an incomplete or unconfirmed test run."])
    except (OSError, ET.ParseError, KeyError, ValueError):
        lines.append("- Coverage unavailable (report missing, unreadable, or malformed).")

    lines.extend(["", "Coverage threshold: Not enforced yet", "", "### Artifacts", ""])
    for name, url in (
        ("backend-test-results", test_url),
        ("backend-coverage-report", coverage_url),
    ):
        lines.append(f"- [{name}]({url})" if url else f"- {name}: unavailable (not uploaded)")
    return "\n".join(lines) + "\n"


def main() -> None:
    backend = Path(__file__).resolve().parents[2] / "backend"
    summary = build_summary(
        backend,
        os.environ.get("PYTEST_OUTCOME", ""),
        os.environ.get("TEST_RESULTS_ARTIFACT_URL", ""),
        os.environ.get("COVERAGE_ARTIFACT_URL", ""),
    )
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with Path(summary_path).open("a", encoding="utf-8") as output:
            output.write(summary)
    else:
        print(summary, end="")


if __name__ == "__main__":
    main()
