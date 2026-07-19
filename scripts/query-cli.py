#!/usr/bin/env python3
"""Query the mailspring-ai-search index from the command line.

Usage:
  python3 scripts/query-cli.py "<query>"
  python3 scripts/query-cli.py --json "<query>"
  python3 scripts/query-cli.py --top 5 "<query>"

Requires: lancedb, fastembed (pip install lancedb fastembed)
"""

import sys
import os
import json
import argparse
import subprocess
import re
import time
from pathlib import Path
from collections import defaultdict
from urllib.parse import urlencode

DB_PATH = Path.home() / '.local' / 'share' / 'mailspring-ai-search'
EMBED_MODEL = 'BAAI/bge-base-en-v1.5'


def search(query: str, top_n: int = 10, where: str = None) -> list:
    import lancedb
    from fastembed import TextEmbedding

    if not DB_PATH.exists():
        print(f'Index not found at {DB_PATH}. Run the mailspring-ai-search plugin first.', file=sys.stderr)
        sys.exit(1)

    db = lancedb.connect(str(DB_PATH))
    if 'emails' not in db.list_tables().tables:
        print('emails table not found. The index may still be building.', file=sys.stderr)
        sys.exit(1)

    t = db.open_table('emails')

    model = TextEmbedding(EMBED_MODEL, providers=['CPUExecutionProvider'])
    vec = list(model.embed([query]))[0].tolist()

    q = t.search(vec).limit(top_n * 3)
    if where:
        q = q.where(where, prefilter=True)
    rows = q.to_list()

    # Deduplicate to unique threads
    seen = {}
    for r in rows:
        tid = r.get('thread_id', r.get('mailspring_id', ''))
        if tid not in seen:
            seen[tid] = r
        if len(seen) >= top_n:
            break

    return list(seen.values())


def mailspring_url(message_id: str) -> str:
    return 'mailspring://plugins?' + urlencode({'action': 'open-message', 'id': message_id})


def format_result(i: int, row: dict) -> str:
    date_ms = row.get('date', 0)
    date_str = time.strftime('%Y-%m-%d', time.gmtime(date_ms / 1000)) if date_ms else '?'
    subject = row.get('subject', '(no subject)')
    from_addr = row.get('from_addr', '')
    labels = ', '.join(row.get('labels', [])[:4])
    snippet = (row.get('chunk_text', '') or '')[:200].replace('\n', ' ')
    mid = row.get('message_id', '')
    url = mailspring_url(mid) if mid else ''

    lines = [
        f'\n{"─" * 60}',
        f'{i}. {subject}',
        f'   {date_str}  ·  {from_addr}',
    ]
    if labels:
        lines.append(f'   Labels: {labels}')
    if url:
        lines.append(f'   {url}')
    if snippet:
        lines.append(f'   {snippet}…' if len(row.get("chunk_text", "")) > 200 else f'   {snippet}')
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description='Search the mailspring-ai-search index')
    ap.add_argument('query', nargs='+')
    ap.add_argument('--top', type=int, default=10)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--where', help='SQL WHERE clause to pre-filter results')
    ap.add_argument('--open', action='store_true', help='Open best match in Mailspring')
    args = ap.parse_args()

    query = ' '.join(args.query)
    results = search(query, args.top, args.where)

    if args.open and results:
        mid = results[0].get('message_id', '')
        if mid:
            subprocess.Popen(['xdg-open', mailspring_url(mid)])

    if args.json:
        print(json.dumps({
            'query': query,
            'count': len(results),
            'results': [{
                'subject': r.get('subject'),
                'from_addr': r.get('from_addr'),
                'date': r.get('date'),
                'labels': r.get('labels', []),
                'message_id': r.get('message_id'),
                'mailspring_url': mailspring_url(r.get('message_id', '')),
                'snippet': (r.get('chunk_text') or '')[:300],
            } for r in results]
        }, indent=2, default=str))
    else:
        print(f'\nQuery: "{query}"  ({len(results)} results)\n')
        for i, r in enumerate(results):
            print(format_result(i + 1, r))


if __name__ == '__main__':
    main()
