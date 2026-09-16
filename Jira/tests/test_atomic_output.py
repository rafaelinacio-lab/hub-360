import ast
import os
import pathlib
import tempfile
import unittest
from contextlib import contextmanager

# Load only the pure writer; importing the extractor would require Jira credentials.
source = pathlib.Path(__file__).resolve().parents[1] / 'jira_extractor.py'
module = ast.parse(source.read_text())
writer = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'atomic_output')

class AtomicOutputTests(unittest.TestCase):
    def test_publish_and_preserve_previous_version_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            env = dict(os=os, tempfile=tempfile, contextmanager=contextmanager, DATA_DIR=root)
            exec(compile(ast.Module(body=[writer], type_ignores=[]), str(source), 'exec'), env)
            target = root / 'dashboard_data.json'
            target.write_text('{"old":true}')
            with self.assertRaises(RuntimeError):
                with env['atomic_output'](target.name) as stream:
                    stream.write('{"partial":')
                    self.assertEqual(target.read_text(), '{"old":true}')
                    raise RuntimeError('simulated interruption')
            self.assertEqual(target.read_text(), '{"old":true}')
            with env['atomic_output'](target.name) as stream:
                stream.write('{"new":true}')
                self.assertEqual(target.read_text(), '{"old":true}')
            self.assertEqual(target.read_text(), '{"new":true}')
            self.assertEqual(list(root.glob('*.tmp')), [])

if __name__ == '__main__':
    unittest.main()
