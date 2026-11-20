#!/usr/bin/env python3
"""Preview or apply retention for terminal task logs and generated verification screenshots.

Stop the control plane before applying. Use its directory layout (inside the
container for a managed installation). Normal deliverables and retained
deployment reports are excluded.
"""
import argparse
import hashlib
import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path


def unchanged_file(root, relative, digest):
    path = root / relative
    if root not in path.parents or not path.is_file() or path.resolve() != path:
        return False
    with path.open('rb') as stream:
        checksum = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest() == digest


def retain(data, workspaces, days, apply):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    database = data / 'codexdeck.sqlite'
    if database.resolve(strict=True) != database:
        raise ValueError('Expected the regular database in the data directory.')
    with closing(sqlite3.connect(database.as_uri() + ('?mode=rw' if apply else '?mode=ro'), uri=True)) as db:
        db.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        if apply and db.execute("SELECT 1 FROM tasks WHERE status IN ('running','queued') LIMIT 1").fetchone():
            raise ValueError('Wait until the task queue is empty.')
        logs = """FROM thread_events WHERE created_at < ? AND
            (type IN ('item/commandExecution/outputDelta','process_stderr','item/agentMessage/delta',
                      'item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/fileChange/outputDelta')
             OR type='output_delta') AND task_id IN
             (SELECT id FROM tasks WHERE status IN ('completed','failed','cancelled'))"""
        count = db.execute('SELECT count(*) ' + logs, (cutoff,)).fetchone()[0]
        protected = set()
        for (report,) in db.execute("""SELECT last_verification_json FROM deployments WHERE
                COALESCE(json_extract(config_json,'$.archived'),0)=0 AND last_verification_json IS NOT NULL"""):
            protected.update((json.loads(report).get('browser') or {}).get('artifacts', []))
        images = db.execute("""SELECT a.id,a.path,a.content_sha256,w.path FROM artifacts a
              JOIN workspaces w ON w.id=a.workspace_id
              WHERE a.change_type='screenshot' AND a.created_at<? AND a.content_sha256 IS NOT NULL""",(cutoff,)).fetchall()
        expired = [i for i in images if i[0] not in protected and re.fullmatch(r'[0-9a-f]{64}',i[2])
                   and re.fullmatch(r'\.codex-artifacts/verify-(?:1440|390)-[0-9a-f-]{36}\.png',i[1])]
        if apply:
            db.execute("UPDATE thread_events SET type='events_expired',payload_json='null' " + logs[logs.index('WHERE'):], (cutoff,))
            db.executemany('DELETE FROM artifacts WHERE id=?',[(i[0],) for i in expired])
            db.commit()
            for _, name, digest, stored in expired:
                root = Path(stored)
                # Docker paths must be resolved in the same namespace as the server.
                if (root == workspaces or workspaces in root.parents) and root.resolve() == root and unchanged_file(root,name,digest):
                    (root / name).unlink()
            for digest in {i[2] for i in expired}:
                if not db.execute('SELECT 1 FROM artifacts WHERE content_sha256=? LIMIT 1',(digest,)).fetchone():
                    relative = 'artifact-blobs/' + digest
                    if unchanged_file(data,relative,digest):
                        (data / relative).unlink()
        return {'applied':apply,'expired_log_payloads':count,'expired_screenshots':len(expired)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',type=Path,required=True)
    parser.add_argument('--workspaces',type=Path,required=True)
    parser.add_argument('--days',type=int,required=True)
    parser.add_argument('--apply',action='store_true')
    args = parser.parse_args()
    if args.days < 1:
        parser.error('--days must be positive')
    print(json.dumps(retain(args.data.resolve(strict=True),args.workspaces.resolve(strict=True),args.days,args.apply)))
