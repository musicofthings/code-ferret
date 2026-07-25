import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import run_tools  # noqa: E402


class RunToolsTests(unittest.TestCase):
    def test_loads_bounded_tool_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / ".codeferret.yaml").write_text(
                "tools:\n  linters: false\n  security: true\n  timeout_seconds: 9999\n",
                encoding="utf-8",
            )
            config = run_tools.load_tool_config(repo)
            self.assertFalse(config["linters"])
            self.assertTrue(config["security"])
            self.assertEqual(config["timeout_seconds"], 600)

    def test_discovers_only_installed_known_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            binary_dir = repo / "node_modules" / ".bin"
            binary_dir.mkdir(parents=True)
            eslint = binary_dir / "eslint"
            eslint.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            eslint.chmod(0o755)
            (repo / "package.json").write_text("{}\n", encoding="utf-8")
            (repo / "src.ts").write_text("const value = 1;\n", encoding="utf-8")
            config = {**run_tools.DEFAULT_TOOLS, "security": False, "dependencies": False, "typecheck": False}
            specs = run_tools.discover_tools(repo, ["src.ts"], config)
            self.assertEqual([spec.name for spec in specs], ["eslint:."])

    def test_loads_and_applies_review_ignore_globs(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / ".ferretignore").write_text("vendor/**\n", encoding="utf-8")
            (repo / ".codeferret.yaml").write_text(
                "reviews:\n  ignore:\n    - \"dist/**\"\n    - '**/*.generated.ts'\n",
                encoding="utf-8",
            )
            patterns = run_tools.load_review_ignores(repo)
            self.assertEqual(patterns, ["vendor/**", "dist/**", "**/*.generated.ts"])
            self.assertTrue(run_tools.glob_matches("**/*.generated.ts", "src/model.generated.ts"))
            self.assertFalse(run_tools.glob_matches("dist/**", "src/index.ts"))

    def test_scrubs_tool_output_and_classifies_findings(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            tool = repo / "fake-tool"
            tool.write_text(
                "#!/bin/sh\necho 'found ghp_abcdefghijklmnopqrstuvwxyz1234567890AB'\nexit 1\n",
                encoding="utf-8",
            )
            tool.chmod(0o755)
            result = run_tools.run_tool(run_tools.ToolSpec("fake", "linter", [str(tool)]), repo, "head", 10)
            self.assertEqual(result.status, "findings")
            self.assertIn("[REDACTED_SECRET]", result.output)
            self.assertNotIn("ghp_", result.output)


if __name__ == "__main__":
    unittest.main()
