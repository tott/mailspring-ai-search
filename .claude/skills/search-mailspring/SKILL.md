---
name: search-mailspring
description: "Search the local mailspring-ai-search email index (LanceDB, bge-m3 embeddings) to answer questions, find email threads, summarise conversations, and open emails in Mailspring. Use when the user asks anything about email content, senders, subjects, invoices, or wants to act on an email. The index is built by the mailspring-ai-search plugin running in Mailspring."
---

# search-mailspring — agent skill

Use this skill whenever the user asks about email content or wants to find, summarise, or act on emails indexed by the mailspring-ai-search plugin.

## Index location

```
~/.local/share/mailspring-ai-search/   (default, configurable in plugin settings)
```

## Index schema

```
message_id    string   — RFC 2822 Message-ID
mailspring_id string   — Mailspring internal UUID  
thread_id     string   — thread grouping key
account_id    string   — Mailspring account UUID
from_addr     string   — sender "name <email>"
to_addrs      string   — recipients
cc_addrs      string   — CC recipients
subject       string   — email subject
date          int64    — Unix timestamp in milliseconds (NOT seconds)
labels        list<string>  — labels/folders (e.g. INBOX, STARRED, work/clients)
has_attachments bool
source_part   string   — "body" | "attachment:filename"
chunk_index   int32    — chunk number within message (0 = metadata header)
chunk_text    string   — indexed text content
vector        float32[768]  — bge-m3 multilingual embeddings
```

## Querying the index

### Semantic + filter search

```python
import lancedb, subprocess, json
from fastembed import TextEmbedding

db = lancedb.connect(os.path.expanduser('~/.local/share/mailspring-ai-search'))
t = db.open_table('emails')

# Pure filter — no embedding needed
rows = t.search().where("from_addr LIKE '%aws%'").limit(20).to_list()

# Semantic search
model = TextEmbedding('BAAI/bge-base-en-v1.5', providers=['CPUExecutionProvider'])
vec = list(model.embed(['invoice billing'])[0]).tolist()
rows = t.search(vec).limit(10).to_list()

# Combined — filter first, then rank by relevance
rows = t.search(vec).where("from_addr LIKE '%aws%'", prefilter=True).limit(10).to_list()
```

### Date filtering

`date` is milliseconds since epoch:

```python
import time
today_ms = int(time.mktime(time.strptime(time.strftime('%Y-%m-%d'), '%Y-%m-%d'))) * 1000
rows = t.search().where(f"date >= {today_ms}").to_list()
```

### Opening emails in Mailspring

```python
import subprocess, urllib.parse
msg_id = rows[0]['message_id']
url = "mailspring://plugins?action=open-message&id=" + urllib.parse.quote(msg_id)
subprocess.Popen(['xdg-open', url])  # Linux
# subprocess.Popen(['open', url])    # macOS
```

The `open-by-id` plugin (included in this project) handles the URL and opens the exact message in Mailspring.

## Reconstructing full threads

All messages in a thread share the same `thread_id`. To reconstruct a conversation:

```python
# Find thread_ids from search results
thread_ids = list({r['thread_id'] for r in results})

# Fetch all chunks for those threads
ids_sql = ', '.join(f"'{t}'" for t in thread_ids)
all_chunks = t.search().where(f"thread_id IN ({ids_sql})").limit(100000).to_list()

# Group and sort
from collections import defaultdict
threads = defaultdict(list)
for chunk in all_chunks:
    threads[chunk['thread_id']].append(chunk)

for tid, chunks in threads.items():
    # Sort by message date, then chunk_index
    chunks.sort(key=lambda c: (c['date'], c['chunk_index']))
    body = '\n'.join(c['chunk_text'] for c in chunks if c['source_part'] == 'body')
    print(chunks[0]['subject'], '\n', body[:500])
```

## Using the query CLI

The project includes a self-contained CLI for querying the index:

```bash
python3 scripts/query-cli.py "AWS invoice"
python3 scripts/query-cli.py --json "emails from Sarah"
python3 scripts/query-cli.py --top 5 --open "flight confirmation"
python3 scripts/query-cli.py --where "date >= 1753228800000" "meeting notes"
```

Dependencies: `pip install lancedb fastembed`

## Caveats

- Index must be built by the mailspring-ai-search plugin running in Mailspring
- Vectors are 768-dim bge-m3 (multilingual — handles mixed-language mailboxes)
- `chunk_index=0` always contains the metadata header (Subject, From, Date, Labels)
- `date` is milliseconds, not seconds
- FTS index (for keyword search) must be created explicitly after initial build:
  `t.create_fts_index('chunk_text', replace=True)`
