import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / 'backup.py'


class BackupTest(unittest.TestCase):
    def test_live_wal_backup_restore_and_tamper_detection(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            data, ws, archive, restored = (base / p for p in ('db', 'ws', 'backup', 'restored'))
            data.mkdir(); ws.mkdir(); (ws / 'sample').mkdir()
            (ws / 'sample' / 'README.md').write_text('release A')
            (data / 'master.key').write_text('fixture excluded from backup')
            (data / 'setup-code').write_text('fixture excluded from backup')
            with closing(sqlite3.connect(data / 'codexdeck.sqlite')) as db, db:
                db.executescript("""PRAGMA journal_mode=WAL;
                    CREATE TABLE workspaces(id TEXT PRIMARY KEY, path TEXT);
                    CREATE TABLE threads(id TEXT PRIMARY KEY, codex_home TEXT);
                    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
                    CREATE TABLE history(id INTEGER PRIMARY KEY);
                    INSERT INTO workspaces VALUES('w','/workspaces/sample');
                    INSERT INTO threads VALUES('t','/data/codex-home-1');
                    INSERT INTO settings VALUES('session:demo','test');""")
            stop, wrote = threading.Event(), threading.Event()
            def writer():
                with closing(sqlite3.connect(data / 'codexdeck.sqlite')) as connection:
                    while not stop.is_set():
                        with connection:
                            connection.execute('INSERT INTO history DEFAULT VALUES')
                        wrote.set(); time.sleep(.002)
            thread = threading.Thread(target=writer); thread.start()
            def run(*args, ok=True):
                result = subprocess.run([sys.executable, str(TOOL), *map(str, args)], capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, ok, result.stderr)
            try:
                self.assertTrue(wrote.wait(5))
                run('backup','--data',data,'--workspaces',ws,'--to',archive,'--managed-data','/data','--managed-workspaces','/workspaces')
            finally:
                stop.set(); thread.join()
            run('verify','--from',archive)
            run('restore','--from',archive,'--to',restored)
            self.assertFalse((restored / 'data/master.key').exists())
            self.assertFalse((restored / 'data/setup-code').exists())
            with closing(sqlite3.connect(restored / 'data/codexdeck.sqlite')) as db:
                location, = db.execute('SELECT path FROM workspaces').fetchone()
                self.assertEqual((Path(location) / 'README.md').read_text(), 'release A')
                self.assertGreater(db.execute('SELECT count(*) FROM history').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT count(*) FROM settings').fetchone()[0], 0)
            (archive / 'workspaces/sample/README.md').write_text('damaged')
            run('restore','--from',archive,'--to',base/'invalid',ok=False)
            self.assertFalse((base/'invalid').exists())


if __name__ == '__main__':
    unittest.main()
