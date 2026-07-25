#!/usr/bin/env python3
"""Run installed CodeFerret analyzers with bounded time and normalized JSON output.

This runner never installs dependencies and never invokes arbitrary package
scripts. It only executes known analyzer binaries already present on PATH or in
the repository's node_modules/.bin directory.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable


DEFAULT_TOOLS = {
    "linters": True,
    "typecheck": True,
    "security": True,
    "dependencies": True,
    "timeout_seconds": 120,
}

SECRET_PATTERNS = [
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}"),
    re.compile(r"(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}"),
    re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    re.compile(r"xox[pborsa]-[0-9A-Za-z-]{20,}"),
    re.compile(r"-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----"),
]


@dataclass
class ToolSpec:
    name: str
    category: str
    command: list[str]
    findings_exit_codes: tuple[int, ...] = (1,)
    cwd: str = "."


@dataclass
class ToolResult:
    name: str
    category: str
    status: str
    exit_code: int | None
    duration_ms: int
    command: list[str]
    output: str


def load_tool_config(repo: Path) -> dict[str, bool | int]:
    config = dict(DEFAULT_TOOLS)
    path = repo / ".codeferret.yaml"
    if not path.is_file():
        return config
    in_tools = False
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            in_tools = line.strip() == "tools:"
            continue
        if not in_tools or indent < 2 or ":" not in line:
            continue
        key, value = (part.strip() for part in line.split(":", 1))
        if key in {"linters", "typecheck", "security", "dependencies"} and value.lower() in {"true", "false"}:
            config[key] = value.lower() == "true"
        elif key == "timeout_seconds" and value.isdigit():
            config[key] = min(600, max(10, int(value)))
    return config


def load_review_ignores(repo: Path) -> list[str]:
    patterns: list[str] = []
    ferretignore = repo / ".ferretignore"
    if ferretignore.is_file():
        for raw_line in ferretignore.read_text(encoding="utf-8", errors="replace").splitlines():
            value = raw_line.split("#", 1)[0].strip()
            if value:
                patterns.append(value)

    config_path = repo / ".codeferret.yaml"
    if not config_path.is_file():
        return patterns
    in_reviews = False
    in_ignore = False
    for raw_line in config_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0:
            in_reviews = stripped == "reviews:"
            in_ignore = False
        elif in_reviews and indent == 2:
            in_ignore = stripped == "ignore:"
        elif in_reviews and in_ignore and indent >= 4 and stripped.startswith("- "):
            value = stripped[2:].strip().strip('"\'')
            if value:
                patterns.append(value)
    return patterns


def glob_matches(pattern: str, path: str) -> bool:
    regex = "^"
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "*" and index + 1 < len(pattern) and pattern[index + 1] == "*":
            if index + 2 < len(pattern) and pattern[index + 2] == "/":
                regex += "(?:.*/)?"
                index += 3
                continue
            regex += ".*"
            index += 2
            continue
        if character == "*":
            regex += "[^/]*"
        elif character == "?":
            regex += "[^/]"
        else:
            regex += re.escape(character)
        index += 1
    return re.fullmatch(regex, path) is not None


def validate_target(repo: Path, target: str) -> list[str]:
    if target == "staged":
        return ["--cached"]
    if target == "head":
        return ["HEAD"]
    check = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", f"{target}^{{commit}}"],
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        raise ValueError(f"unknown base ref: {target}")
    return [f"{target}...HEAD"]


def changed_files(repo: Path, target: str) -> list[str]:
    diff_args = validate_target(repo, target)
    result = subprocess.run(
        ["git", "-C", str(repo), "diff", *diff_args, "--name-only", "-z"],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError("failed to collect changed files")
    files = [part.decode("utf-8", "surrogateescape") for part in result.stdout.split(b"\0") if part]
    if target == "head":
        untracked = subprocess.run(
            ["git", "-C", str(repo), "ls-files", "--others", "--exclude-standard", "-z"],
            capture_output=True,
        )
        if untracked.returncode != 0:
            raise RuntimeError("failed to collect untracked files")
        files.extend(part.decode("utf-8", "surrogateescape") for part in untracked.stdout.split(b"\0") if part)
    return list(dict.fromkeys(files))


def executable(repo: Path, name: str, which: Callable[[str], str | None] = shutil.which) -> str | None:
    local = repo / "node_modules" / ".bin" / name
    if local.is_file() and os.access(local, os.X_OK):
        return str(local)
    return which(name)


def project_roots(repo: Path, files: list[str], marker: str) -> list[Path]:
    roots: set[Path] = set()
    for file in files:
        current = (repo / file).parent
        while current == repo or repo in current.parents:
            if (current / marker).is_file():
                roots.add(current)
                break
            if current == repo:
                break
            current = current.parent
    if (repo / marker).is_file():
        roots.add(repo)
    return sorted(roots)


def discover_tools(repo: Path, files: list[str], config: dict[str, bool | int]) -> list[ToolSpec]:
    specs: list[ToolSpec] = []
    existing = [file for file in files if (repo / file).is_file()]
    js_files = [file for file in existing if Path(file).suffix.lower() in {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}]
    python_files = [file for file in existing if Path(file).suffix.lower() == ".py"]
    shell_files = [file for file in existing if Path(file).suffix.lower() in {".sh", ".bash", ".zsh", ".ksh"}]

    if config["linters"]:
        for project in project_roots(repo, js_files, "package.json"):
            eslint = executable(project, "eslint")
            project_files = [
                str((repo / file).relative_to(project))
                for file in js_files
                if project == (repo / file).parent or project in (repo / file).parents
            ]
            if eslint and project_files:
                specs.append(
                    ToolSpec(
                        f"eslint:{project.relative_to(repo) or '.'}",
                        "linter",
                        [eslint, "--format", "json", "--no-error-on-unmatched-pattern", "--", *project_files],
                        cwd=str(project.relative_to(repo) or "."),
                    )
                )
        ruff = executable(repo, "ruff")
        if ruff and python_files:
            specs.append(ToolSpec("ruff", "linter", [ruff, "check", "--output-format", "json", *python_files]))
        shellcheck = executable(repo, "shellcheck")
        if shellcheck and shell_files:
            specs.append(ToolSpec("shellcheck", "linter", [shellcheck, "--format", "json1", *shell_files]))

    if config["typecheck"]:
        for project in project_roots(repo, existing, "tsconfig.json"):
            tsc = executable(project, "tsc")
            if tsc:
                specs.append(
                    ToolSpec(
                        f"typescript:{project.relative_to(repo) or '.'}",
                        "typecheck",
                        [tsc, "--noEmit", "--pretty", "false"],
                        (1, 2),
                        str(project.relative_to(repo) or "."),
                    )
                )

    if config["security"]:
        scanner = Path(__file__).with_name("scan-secrets.sh")
        specs.append(ToolSpec("codeferret-secrets", "security", ["bash", str(scanner), target_placeholder()]))
        semgrep = executable(repo, "semgrep")
        semgrep_config = next((path for path in (repo / ".semgrep.yml", repo / ".semgrep.yaml") if path.is_file()), None)
        if semgrep and semgrep_config and existing:
            specs.append(ToolSpec("semgrep", "security", [semgrep, "scan", "--config", str(semgrep_config), "--json", "--error", *existing]))

    if config["dependencies"]:
        for project in project_roots(repo, existing, "package-lock.json"):
            npm = executable(project, "npm")
            if npm:
                specs.append(
                    ToolSpec(
                        f"npm-audit:{project.relative_to(repo) or '.'}",
                        "dependency",
                        [npm, "audit", "--json", "--omit=dev"],
                        cwd=str(project.relative_to(repo) or "."),
                    )
                )
        for project in project_roots(repo, existing, "requirements.txt"):
            pip_audit = executable(project, "pip-audit")
            if pip_audit:
                specs.append(
                    ToolSpec(
                        f"pip-audit:{project.relative_to(repo) or '.'}",
                        "dependency",
                        [pip_audit, "-r", "requirements.txt", "--format", "json"],
                        cwd=str(project.relative_to(repo) or "."),
                    )
                )
    return specs


def target_placeholder() -> str:
    return "__CODEFERRET_TARGET__"


def scrub(text: str) -> str:
    sanitized = text
    for pattern in SECRET_PATTERNS:
        sanitized = pattern.sub("[REDACTED_SECRET]", sanitized)
    return sanitized[:50_000]


def run_tool(spec: ToolSpec, repo: Path, target: str, timeout: int) -> ToolResult:
    command = [target if arg == target_placeholder() else arg for arg in spec.command]
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=repo / spec.cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            env={**os.environ, "CI": "1", "NO_COLOR": "1"},
        )
        if completed.returncode == 0:
            status = "passed"
        elif completed.returncode in spec.findings_exit_codes:
            status = "findings"
        else:
            status = "error"
        output = scrub("\n".join(part for part in (completed.stdout, completed.stderr) if part))
        return ToolResult(
            spec.name,
            spec.category,
            status,
            completed.returncode,
            round((time.monotonic() - started) * 1000),
            [Path(command[0]).name, *command[1:]],
            output,
        )
    except subprocess.TimeoutExpired as error:
        output = scrub("\n".join(str(part or "") for part in (error.stdout, error.stderr)))
        return ToolResult(
            spec.name,
            spec.category,
            "timeout",
            None,
            round((time.monotonic() - started) * 1000),
            [Path(command[0]).name, *command[1:]],
            output,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?", default="head")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--output", default=".ferret/tool-results.json")
    parser.add_argument("--print", action="store_true", dest="print_output")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    try:
        subprocess.run(["git", "-C", str(repo), "rev-parse", "--show-toplevel"], check=True, capture_output=True)
        files = changed_files(repo, args.target)
        ignore_patterns = load_review_ignores(repo)
        files = [file for file in files if not any(glob_matches(pattern, file) for pattern in ignore_patterns)]
        config = load_tool_config(repo)
        specs = discover_tools(repo, files, config)
        results = [run_tool(spec, repo, args.target, int(config["timeout_seconds"])) for spec in specs]
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    document = {
        "version": 1,
        "target": args.target,
        "changed_files": files,
        "tools": [asdict(result) for result in results],
        "summary": {
            status: sum(1 for result in results if result.status == status)
            for status in ("passed", "findings", "error", "timeout")
        },
    }
    output = repo / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    if args.print_output:
        print(json.dumps(document, indent=2))
    else:
        print(f"CodeFerret tools: {len(results)} ran; {document['summary']['findings']} reported findings; results: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
