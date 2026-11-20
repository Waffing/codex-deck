#!/usr/bin/env python3
"""Back up a WAL database and its stable application files, or restore to a fresh directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath, PurePosixPath
import shutil
import sqlite3
import stat
import sys
import tempfile
from contextlib import closing

DB = 'codexdeck.sqlite'
OMIT = {DB, DB + '-wal', DB + '-shm', DB + '-journal', 'master.key', 'setup-code', 'caches', 'home', 'server-profile.json'}


def fail(message):
    raise ValueError(message)


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def tree(root, skip=lambda path: False):
    entries = {}
    def visit(directory):
        for file in sorted(directory.iterdir()):
            if skip(file):
                continue
            info = file.lstat()
            if file.is_symlink() or file.resolve(strict=True) != file:
                fail(f'Symbolic links require a filesystem-level backup: {file.relative_to(root)}')
            key = file.relative_to(root).as_posix()
            if stat.S_ISDIR(info.st_mode):
                entries[key] = ('directory',)
                visit(file)
            elif stat.S_ISREG(info.st_mode):
                entries[key] = ('file', info.st_mode & 0o777, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino)
            else:
                fail(f'Unsupported special file: {key}')
    visit(root)
    return entries


def copy_tree(source, out, entries):
    for name, entry in entries.items():
        target = out / name
        if entry[0] == 'directory':
            target.mkdir(mode=0o700)
        else:
            src = source / name
            if src.resolve(strict=True) != src:
                fail('A file changed during backup. Retry after workspace writes finish.')
            shutil.copy2(src, target)


def validate(root):
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 1:
        fail('Unknown backup format.')
    actual = {name: digest(root / name) for name, entry in tree(root).items()
              if entry[0] == 'file' and name != 'manifest.json'}
    if actual != manifest['sha256']:
        fail('Backup checksum mismatch.')
    with closing(sqlite3.connect((root / 'data' / DB).as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchone():
            fail('SQLite integrity check failed.')
    return manifest


def rebase(value, old_root, new_root):
    style = PureWindowsPath if PureWindowsPath(old_root).drive else PurePosixPath
    suffix = style(value).relative_to(style(old_root))
    if '..' in suffix.parts:
        fail('Database contains an invalid managed path.')
    return str(new_root.joinpath(*suffix.parts))


def backup(data, workspaces, out, managed_data=None, managed_workspaces=None):
    if data == workspaces or workspaces in data.parents:
        fail('The workspace root must not contain the data directory.')
    secret_inodes = set()
    for name in ('master.key', 'setup-code'):
        file = data / name
        if file.is_file():
            info = file.stat()
            secret_inodes.add((info.st_dev, info.st_ino))
    def is_secret(p):
        info = p.lstat()
        return (info.st_dev, info.st_ino) in secret_inodes
    def skip_data(p):
        return p == workspaces or (p.parent == data and (p.name in OMIT or p.name.startswith('.env'))) or is_secret(p)
    def skip_work(p):
        return p.name == 'node_modules' or is_secret(p)
    sources = [(data, out / 'data', skip_data), (workspaces, out / 'workspaces', skip_work)]
    before = [tree(source, skip) for source, _, skip in sources]
    for (source, destination, _), entries in zip(sources, before):
        destination.mkdir(mode=0o700)
        copy_tree(source, destination, entries)
    source_db = data / DB
    if source_db.is_symlink() or not source_db.is_file():
        fail('Missing regular database file.')
    with closing(sqlite3.connect(source_db.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(out / 'data' / DB)) as dest:
        src.backup(dest, pages=256)
        dest.execute('PRAGMA journal_mode=DELETE')
    if before != [tree(source, skip) for source, _, skip in sources]:
        fail('Application files changed during backup. Retry after filesystem writes finish.')
    checks = {name: digest(out / name) for name, entry in tree(out).items() if entry[0] == 'file'}
    (out / 'manifest.json').write_text(json.dumps({'format': 1, 'data': str(managed_data or data), 'workspaces': str(managed_workspaces or workspaces), 'sha256': checks}), encoding='utf-8')
    validate(out)


def restore(source, out, target_data, target_workspaces):
    manifest = validate(source)
    for name in ('data', 'workspaces'):
        (out / name).mkdir(mode=0o700)
        copy_tree(source / name, out / name, tree(source / name))
    for name, expected in manifest['sha256'].items():
        if digest(out / name) != expected:
            fail('Backup changed during restore.')
    with closing(sqlite3.connect(out / 'data' / DB)) as db, db:
        for table, column, previous, target in [('workspaces', 'path', manifest['workspaces'], target_workspaces), ('threads', 'codex_home', manifest['data'], target_data)]:
            for ident, value in db.execute(f'SELECT id,{column} FROM {table} WHERE {column} IS NOT NULL').fetchall():
                db.execute(f'UPDATE {table} SET {column}=? WHERE id=?', (rebase(value, previous, target), ident))
        db.execute("DELETE FROM settings WHERE key LIKE 'session:%'")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    b = commands.add_parser('backup')
    for option in ('data', 'workspaces', 'to'):
        b.add_argument('--' + option, required=True, type=Path)
    b.add_argument('--managed-data', help='original absolute data path as seen by the server')
    b.add_argument('--managed-workspaces', help='original absolute workspace root as seen by the server')
    r = commands.add_parser('restore')
    r.add_argument('--from', dest='source', required=True, type=Path)
    r.add_argument('--to', required=True, type=Path)
    r.add_argument('--target-data', type=Path, help='absolute path as seen by the restored server')
    r.add_argument('--target-workspaces', type=Path, help='absolute path as seen by the restored server')
    v = commands.add_parser('verify')
    v.add_argument('--from', dest='source', required=True, type=Path)
    args = parser.parse_args()
    if args.command == 'verify':
        validate(args.source.resolve(strict=True))
    else:
        dest = args.to.absolute()
        sources = [args.data.resolve(strict=True), args.workspaces.resolve(strict=True)] if args.command == 'backup' else [args.source.resolve(strict=True)]
        if dest.exists() or dest.is_symlink() or dest.parent.resolve(strict=True) != dest.parent or any(dest == src or src in dest.parents for src in sources):
            fail('Choose a new destination outside the source directories with an existing parent.')
        with tempfile.TemporaryDirectory(dir=dest.parent, prefix='.codexdeck-') as private:
            work = Path(private) / 'snapshot'
            work.mkdir(mode=0o700)
            if args.command == 'backup':
                backup(*sources, work, args.managed_data, args.managed_workspaces)
            else:
                target_data = args.target_data or dest / 'data'
                target_ws = args.target_workspaces or dest / 'workspaces'
                if not target_data.is_absolute() or not target_ws.is_absolute():
                    fail('Restored server paths must be absolute.')
                restore(sources[0], work, target_data, target_ws)
            work.rename(dest)
    print(f'{args.command} complete')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.DatabaseError) as error:
        sys.exit(str(error))
