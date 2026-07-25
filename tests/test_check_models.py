import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import check_models  # noqa: E402


def make_registry() -> dict:
    return {
        "version": 1,
        "updated_at": "2026-01-01",
        "providers": {
            "anthropic": {
                "api_kind": "anthropic-messages",
                "models_endpoint": "https://api.anthropic.com/v1/models",
                "key_env": ["ANTHROPIC_API_KEY"],
                "default_model": "claude-sonnet-5",
                "fallback_models": ["claude-opus-5"],
                "model_id_pattern": "^claude-",
                "models": [],
                "available_models": ["claude-opus-5", "claude-sonnet-5"],
                "docs": [
                    {"name": "models", "url": "https://example.test/docs", "sha256": None, "last_checked": None}
                ],
            },
            "google": {
                "api_kind": "gemini-generate-content",
                "models_endpoint": "https://generativelanguage.googleapis.com/v1beta/models",
                "key_env": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
                "default_model": "gemini-3.6-flash",
                "fallback_models": ["gemini-3.1-pro"],
                "model_id_pattern": "^gemini-",
                "models": [],
                "docs": [],
            },
        },
    }


class FakeFetcher:
    def __init__(self, responses: dict[str, bytes]):
        self.responses = responses
        self.requests: list[tuple[str, dict]] = []

    def __call__(self, url: str, headers: dict | None = None) -> bytes:
        self.requests.append((url, headers or {}))
        for prefix, payload in self.responses.items():
            if url.startswith(prefix):
                return payload
        raise RuntimeError(f"unexpected url {url}")


class CheckModelsTests(unittest.TestCase):
    def test_parses_provider_model_listings_per_api_kind(self):
        anthropic = {"api_kind": "anthropic-messages", "model_id_pattern": "^claude-"}
        payload = json.dumps({"data": [{"id": "claude-opus-5"}, {"id": "other-model"}]}).encode()
        self.assertEqual(check_models.parse_model_listing(anthropic, payload), ["claude-opus-5", "other-model"])

        gemini = {"api_kind": "gemini-generate-content", "model_id_pattern": "^gemini-"}
        payload = json.dumps({"models": [{"name": "models/gemini-3.6-flash"}]}).encode()
        self.assertEqual(check_models.parse_model_listing(gemini, payload), ["gemini-3.6-flash"])

    def test_filters_listings_by_family_pattern_and_sorts(self):
        spec = {
            "api_kind": "anthropic-messages",
            "models_endpoint": "https://api.anthropic.com/v1/models",
            "model_id_pattern": "^claude-",
        }
        fetcher = FakeFetcher(
            {
                "https://api.anthropic.com/v1/models": json.dumps(
                    {"data": [{"id": "claude-sonnet-5"}, {"id": "claude-opus-5"}, {"id": "voyage-3"}]}
                ).encode()
            }
        )
        models = check_models.list_provider_models(spec, "key", fetcher)
        self.assertEqual(models, ["claude-opus-5", "claude-sonnet-5"])
        self.assertEqual(fetcher.requests[0][1]["x-api-key"], "key")

    def test_reports_added_and_removed_models(self):
        registry = make_registry()
        spec = registry["providers"]["anthropic"]
        notes = check_models.update_provider_models(
            "anthropic", spec, ["claude-fable-6", "claude-opus-5", "claude-sonnet-5"]
        )
        self.assertEqual(len(notes), 1)
        self.assertIn("claude-fable-6", notes[0])
        self.assertIn("new models available", notes[0])

    def test_promotes_fallback_when_default_is_retired(self):
        registry = make_registry()
        spec = registry["providers"]["anthropic"]
        notes = check_models.update_provider_models("anthropic", spec, ["claude-opus-5"])
        self.assertEqual(spec["default_model"], "claude-opus-5")
        self.assertTrue(any("switched default to fallback" in note for note in notes))

    def test_warns_when_default_and_fallbacks_are_gone(self):
        registry = make_registry()
        spec = registry["providers"]["anthropic"]
        notes = check_models.update_provider_models("anthropic", spec, ["claude-haiku-4"])
        self.assertEqual(spec["default_model"], "claude-sonnet-5")
        self.assertTrue(any("manual update required" in note for note in notes))

    def test_doc_hashing_detects_changes_and_ignores_whitespace(self):
        registry = make_registry()
        spec = registry["providers"]["anthropic"]
        fetcher = FakeFetcher({"https://example.test/docs": b"The  Messages   API\n"})
        notes = check_models.check_provider_docs("anthropic", spec, "2026-07-25", fetcher)
        self.assertEqual(notes, [])
        first_hash = spec["docs"][0]["sha256"]

        fetcher = FakeFetcher({"https://example.test/docs": b"  The Messages API "})
        notes = check_models.check_provider_docs("anthropic", spec, "2026-07-26", fetcher)
        self.assertEqual(notes, [])
        self.assertEqual(spec["docs"][0]["sha256"], first_hash)

        fetcher = FakeFetcher({"https://example.test/docs": b"The Messages API v2"})
        notes = check_models.check_provider_docs("anthropic", spec, "2026-07-27", fetcher)
        self.assertTrue(any("changed since the last check" in note for note in notes))

    def test_run_check_skips_providers_without_keys(self):
        registry = make_registry()
        fetcher = FakeFetcher(
            {
                "https://api.anthropic.com/v1/models": json.dumps(
                    {"data": [{"id": "claude-opus-5"}, {"id": "claude-sonnet-5"}]}
                ).encode(),
                "https://example.test/docs": b"docs",
            }
        )
        notes = check_models.run_check(
            registry, {"ANTHROPIC_API_KEY": "key"}, fetcher, today="2026-07-25"
        )
        self.assertTrue(any("google: skipped" in note for note in notes))
        self.assertEqual(registry["updated_at"], "2026-07-25")
        self.assertEqual(
            registry["providers"]["anthropic"]["available_models"],
            ["claude-opus-5", "claude-sonnet-5"],
        )

    def test_report_renders_actionable_and_skipped_sections(self):
        report = check_models.render_report(
            ["- anthropic: new models available: `claude-fable-6`", "- google: skipped model listing (no API key configured)"],
            "2026-07-25",
        )
        self.assertIn("### Changes and warnings", report)
        self.assertIn("claude-fable-6", report)
        self.assertIn("### Skipped", report)


if __name__ == "__main__":
    unittest.main()
