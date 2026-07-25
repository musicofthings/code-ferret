#!/usr/bin/env python3
"""CodeFerret weekly model & API-docs checker.

Refreshes the repo-root models.json registry against each provider's live
model-listing API and watches provider API documentation for changes:

  * queries the models endpoint of every provider whose API key is present in
    the environment (providers without a key are skipped, never failed);
  * records the observed model IDs matching the provider's family pattern in
    the registry's ``available_models`` field and reports additions/removals;
  * verifies the registry's ``default_model`` is still served, and if it has
    been retired, promotes the first still-available fallback model;
  * hashes each provider's documentation pages (whitespace-normalized) so doc
    revisions show up as registry diffs.

Run by .github/workflows/model-check.yml on a weekly schedule; any resulting
registry change is proposed as a pull request. Uses only the standard library.

Usage:
  check_models.py [--registry models.json] [--report report.md] [--skip-docs]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "codeferret-model-check/1.0"
FETCH_TIMEOUT_SECONDS = 30


def http_fetch(url: str, headers: dict[str, str] | None = None) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
        return response.read()


def provider_api_key(spec: dict, env: dict[str, str]) -> str | None:
    for name in spec.get("key_env", []):
        value = env.get(name)
        if value:
            return value
    return None


def models_request_headers(spec: dict, api_key: str) -> dict[str, str]:
    kind = spec["api_kind"]
    if kind == "anthropic-messages":
        return {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    if kind == "gemini-generate-content":
        return {"x-goog-api-key": api_key}
    return {"Authorization": f"Bearer {api_key}"}


def parse_model_listing(spec: dict, payload: bytes) -> list[str]:
    data = json.loads(payload)
    if spec["api_kind"] == "gemini-generate-content":
        entries = data.get("models", [])
        names = [str(entry.get("name", "")) for entry in entries]
        return [name.removeprefix("models/") for name in names if name]
    entries = data.get("data", [])
    return [str(entry.get("id", "")) for entry in entries if entry.get("id")]


def list_provider_models(spec: dict, api_key: str, fetch=http_fetch) -> list[str]:
    url = spec["models_endpoint"]
    if spec["api_kind"] == "gemini-generate-content":
        url += "?pageSize=200"
    payload = fetch(url, models_request_headers(spec, api_key))
    pattern = re.compile(spec["model_id_pattern"])
    return sorted({model for model in parse_model_listing(spec, payload) if pattern.search(model)})


def normalized_doc_hash(payload: bytes) -> str:
    text = payload.decode("utf-8", errors="replace")
    normalized = re.sub(r"\s+", " ", text).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def check_provider_docs(provider_id: str, spec: dict, today: str, fetch=http_fetch) -> list[str]:
    notes: list[str] = []
    for doc in spec.get("docs", []):
        try:
            digest = normalized_doc_hash(fetch(doc["url"]))
        except Exception as error:  # noqa: BLE001 - report and continue
            notes.append(f"- {provider_id}: could not fetch docs `{doc['name']}` ({error})")
            continue
        if doc.get("sha256") and doc["sha256"] != digest:
            notes.append(
                f"- {provider_id}: API docs `{doc['name']}` changed since the last check "
                f"([view]({doc['url']})) — review for breaking API changes."
            )
        doc["sha256"] = digest
        doc["last_checked"] = today
    return notes


def update_provider_models(provider_id: str, spec: dict, available: list[str]) -> list[str]:
    notes: list[str] = []
    previous = set(spec.get("available_models", []))
    current = set(available)

    added = sorted(current - previous)
    removed = sorted(previous - current)
    if previous and added:
        notes.append(f"- {provider_id}: new models available: {', '.join(f'`{m}`' for m in added)}")
    if previous and removed:
        notes.append(f"- {provider_id}: models no longer listed: {', '.join(f'`{m}`' for m in removed)}")
    spec["available_models"] = available

    default = spec.get("default_model")
    if available and default not in current:
        replacement = next((m for m in spec.get("fallback_models", []) if m in current), None)
        if replacement:
            spec["default_model"] = replacement
            notes.append(
                f"- {provider_id}: default model `{default}` is no longer served; "
                f"switched default to fallback `{replacement}`."
            )
        else:
            notes.append(
                f"- {provider_id}: default model `{default}` is no longer served and no fallback "
                "is available — manual update required."
            )
    return notes


def run_check(
    registry: dict,
    env: dict[str, str],
    fetch=http_fetch,
    skip_docs: bool = False,
    today: str | None = None,
) -> list[str]:
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    notes: list[str] = []
    for provider_id, spec in registry.get("providers", {}).items():
        api_key = provider_api_key(spec, env)
        if not api_key:
            notes.append(f"- {provider_id}: skipped model listing (no API key configured)")
        else:
            try:
                available = list_provider_models(spec, api_key, fetch)
            except Exception as error:  # noqa: BLE001 - report and continue
                notes.append(f"- {provider_id}: model listing failed ({error})")
            else:
                notes.extend(update_provider_models(provider_id, spec, available))
        if not skip_docs:
            notes.extend(check_provider_docs(provider_id, spec, today, fetch))
    registry["updated_at"] = today
    return notes


def render_report(notes: list[str], today: str) -> str:
    lines = [
        "## CodeFerret weekly model & API-docs check",
        "",
        f"Run date: {today}",
        "",
    ]
    actionable = [note for note in notes if "skipped" not in note]
    if actionable:
        lines.append("### Changes and warnings")
        lines.extend(actionable)
    else:
        lines.append("No model or documentation changes detected.")
    skipped = [note for note in notes if "skipped" in note]
    if skipped:
        lines += ["", "### Skipped"]
        lines.extend(skipped)
    lines += [
        "",
        "Registry: `models.json` — consumed by the Cloudflare Worker (`worker/src/providers.ts`)",
        "and the packaging docs. Review the diff before merging.",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=str(Path(__file__).resolve().parents[1] / "models.json"))
    parser.add_argument("--report", default=None, help="Write a markdown report to this path")
    parser.add_argument("--skip-docs", action="store_true", help="Skip documentation hashing")
    args = parser.parse_args(argv)

    registry_path = Path(args.registry)
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    notes = run_check(registry, dict(os.environ), skip_docs=args.skip_docs)
    registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    today = registry["updated_at"]
    report = render_report(notes, today)
    print(report)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
