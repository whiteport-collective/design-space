import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hooks"))

from agent_state import canonical_agent_name, read_state, state_path, write_state


class AgentStateTests(unittest.TestCase):
    def test_canonical_agent_name_strips_numeric_session_suffix(self):
        self.assertEqual(canonical_agent_name("freya-2567"), "freya")
        self.assertEqual(canonical_agent_name("codex"), "codex")

    def test_write_state_trims_to_word_limit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            content = " ".join(f"word{i}" for i in range(350))
            path = write_state("mimir-8403", content, root=root, limit=300)

            self.assertEqual(path, state_path("mimir", root=root))
            saved = read_state("mimir-8403", root=root)
            self.assertEqual(len(saved.split()), 300)


if __name__ == "__main__":
    unittest.main()
