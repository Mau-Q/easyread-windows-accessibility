#!/usr/bin/env python3
"""Check publishable paths and obvious credential/private-path leaks; print no values.

This is a bounded local check, not a guarantee that all secrets can be detected.
Run a dedicated secret scanner as well before publishing new content/history.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_DIRS = {
    '.git', '.venv', 'node_modules', '__pycache__', '.easyread', '.pdf-reading',
    '.selection-translations', '.pdf-reflow', '.pdf-dual-experiments',
    'target', '.codex', '.claude',
}
FORBIDDEN_DATA_ROOTS = {'library', 'runtime', 'output', 'course-data', 'ci-library',
                        '.easyread-test-data', 'test-results', 'playwright-report'}
FORBIDDEN_ROOT = {'config.json', 'prefs.json', '.prefs.json', '.server.json',
                  '.models-seen.json', 'desktop.log'}
FORBIDDEN_SUFFIX = {'.sqlite', '.sqlite3', '.db', '.log', '.pem', '.key', '.p12', '.pfx', '.docx'}
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github-token': re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}'),
    'api-token': re.compile(r'sk-[A-Za-z0-9_-]{20,}'),
    'developer-home': re.compile('/' + r'Users/[^/\s\x22\x27]+/'),
    'credential-url': re.compile(r'https?://[^/\s:@]+:[^/\s@]+@'),
}


def candidates():
    if (ROOT / '.git').exists():
        data = subprocess.check_output(
            ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
        return sorted(set(filter(None, data.decode().split('\0'))))
    return sorted(p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*')
                  if p.is_file() and not set(p.relative_to(ROOT).parts) & FORBIDDEN_DIRS)


def main():
    problems = []
    paths = candidates()
    for name in paths:
        path = ROOT / name
        relative = Path(name)
        if (set(relative.parts) & FORBIDDEN_DIRS or relative.parts[0] in FORBIDDEN_DATA_ROOTS
                or name in FORBIDDEN_ROOT
                or path.suffix.lower() in FORBIDDEN_SUFFIX
                or (path.name.startswith('.env') and path.name != '.env.example')
                or path.is_symlink()):
            problems.append((name, 'forbidden-path'))
            continue
        if not path.is_file():
            continue
        try:
            body = path.read_text(encoding='utf-8')
        except UnicodeError:
            continue
        for line_number, line in enumerate(body.splitlines(), 1):
            for category, pattern in PATTERNS.items():
                # Vendored runtimes may contain generic environment paths.
                if category == 'developer-home' and name.startswith('easyread/web/vendor/'):
                    continue
                if pattern.search(line):
                    problems.append((name, f'{category}:line-{line_number}'))
    if problems:
        for name, category in problems:
            print(f'BLOCKED {name}: {category}')
        return 1
    print(f'Public-tree checks passed for {len(paths)} files; no matching values printed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
