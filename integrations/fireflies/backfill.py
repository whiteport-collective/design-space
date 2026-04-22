#!/usr/bin/env python3
"""
Fireflies → Design Space backfill (Python port of sync.ts)
Usage: python backfill.py [--days 30]
"""
import os, sys, json, re, math, urllib.request, urllib.parse
from datetime import datetime, timezone

FIREFLIES_KEY = os.environ.get("FIREFLIES_API_KEY")
DS_URL = os.environ.get("DESIGN_SPACE_URL", "https://uztngidbpduyodrabokm.supabase.co") + "/functions/v1"
DS_KEY = os.environ.get("DESIGN_SPACE_ANON_KEY")
DS_REST = os.environ.get("DESIGN_SPACE_URL", "https://uztngidbpduyodrabokm.supabase.co")

if not FIREFLIES_KEY:
    sys.exit("ERROR: FIREFLIES_API_KEY env var is required")
if not DS_KEY:
    sys.exit("ERROR: DESIGN_SPACE_ANON_KEY env var is required")
MAX_CHUNK_CHARS = 3200

def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        "https://api.fireflies.ai/graphql",
        data=body,
        headers={"Authorization": f"Bearer {FIREFLIES_KEY}", "Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def list_transcripts(days=30):
    cutoff_ms = int((datetime.now(timezone.utc).timestamp() - days * 86400) * 1000)
    data = gql("""query { transcripts(limit: 50) {
        id title date duration
    }}""")
    all_t = data["data"]["transcripts"] or []
    return [t for t in all_t if t["date"] >= cutoff_ms]

def fetch_transcript(tid):
    data = gql("""query Transcript($id: String!) {
        transcript(id: $id) {
            id title date duration organizer_email participants
            speakers { id name }
            sentences { speaker_name text start_time end_time }
            summary { action_items keywords overview shorthand_bullet }
        }
    }""", {"id": tid})
    return data["data"]["transcript"]

def normalize_time(v):
    try: return float(v) if v is not None else 0.0
    except: return 0.0

def chunk_transcript(t):
    speakers = t.get("speakers") or []
    sentences = t.get("sentences") or []
    summary = t.get("summary") or {}
    keywords = summary.get("keywords") or []
    speaker_names = [s["name"] for s in speakers]
    date_str = datetime.fromtimestamp(t["date"]/1000, tz=timezone.utc).strftime("%Y-%m-%d")
    mins = round(t["duration"])
    preamble = f"Meeting: {t['title']} | {date_str} | {mins}min | Speakers: {', '.join(speaker_names)}"

    chunks = []
    idx = 0
    transcript_end = normalize_time(sentences[-1]["end_time"]) if sentences else round(t["duration"] * 60)

    # Summary chunk
    if summary.get("overview"):
        parts = [preamble, "", f"## Overview\n{summary['overview']}"]
        if summary.get("action_items"):
            parts.append("\n## Action Items")
            parts += [f"- {i}" for i in summary["action_items"]]
        if summary.get("shorthand_bullet"):
            parts.append("\n## Key Points")
            parts += [f"- {p}" for p in summary["shorthand_bullet"]]
        chunks.append({"content": "\n".join(parts), "topics": keywords, "speakers": speaker_names,
                        "startTime": 0, "endTime": transcript_end, "isSummary": True, "chunkIndex": idx})
        idx += 1

    if not sentences:
        return chunks

    current_parts = [preamble, ""]
    current_len = len(preamble)
    chunk_start = normalize_time(sentences[0]["start_time"])
    chunk_end = 0.0
    chunk_speakers = set()
    prev_speaker = ""
    block_text = ""

    def emit_block():
        nonlocal current_parts, current_len, chunk_start, chunk_end, chunk_speakers, idx
        if not block_text:
            return
        line = f"**{prev_speaker}:** {block_text}"
        if current_len + len(line) > MAX_CHUNK_CHARS and len(current_parts) > 2:
            chunks.append({"content": "\n".join(current_parts), "topics": keywords,
                            "speakers": list(chunk_speakers), "startTime": chunk_start,
                            "endTime": chunk_end, "isSummary": False, "chunkIndex": idx})
            idx += 1
            current_parts = [preamble, ""]
            current_len = len(preamble)
            chunk_start = chunk_end
            chunk_speakers.clear()
        current_parts.append(line)
        current_len += len(line)
        chunk_speakers.add(prev_speaker)

    for s in sentences:
        if s["speaker_name"] != prev_speaker and block_text:
            emit_block()
            block_text = ""
        prev_speaker = s["speaker_name"]
        block_text = (block_text + " " if block_text else "") + s["text"]
        chunk_end = normalize_time(s["end_time"])

    emit_block()

    if len(current_parts) > 2:
        chunks.append({"content": "\n".join(current_parts), "topics": keywords,
                        "speakers": list(chunk_speakers), "startTime": chunk_start,
                        "endTime": chunk_end, "isSummary": False, "chunkIndex": idx})

    return chunks

def get_existing(source_file):
    url = f"{DS_REST}/rest/v1/design_space?source_file=eq.{urllib.parse.quote(source_file)}&select=content,metadata"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {DS_KEY}", "apikey": DS_KEY
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def capture_chunk(content, meta):
    body = json.dumps({
        "content": content, "category": "meeting_transcript",
        "project": meta["project"], "designer": meta["designer"],
        "topics": meta["topics"], "components": [],
        "source": "fireflies", "source_file": meta["source_file"],
        "metadata": {k: v for k, v in meta.items() if k not in ("project","designer","topics","source_file")}
    }).encode()
    req = urllib.request.Request(
        f"{DS_URL}/capture-design-space", data=body,
        headers={"Authorization": f"Bearer {DS_KEY}", "Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def send_notification(content, project):
    body = json.dumps({
        "action": "send", "from_agent": "fireflies-bot", "to_agent": None,
        "content": content, "message_type": "notification",
        "project": project, "priority": "normal", "topics": ["meeting", "transcript"]
    }).encode()
    req = urllib.request.Request(
        f"{DS_URL}/agent-messages", data=body,
        headers={"Authorization": f"Bearer {DS_KEY}", "Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req): pass
    except: pass

def process(tid):
    source_file = f"fireflies:{tid}"
    t = fetch_transcript(tid)
    chunks = chunk_transcript(t)
    speakers = [s["name"] for s in (t.get("speakers") or [])]
    date_str = datetime.fromtimestamp(t["date"]/1000, tz=timezone.utc).strftime("%Y-%m-%d")

    existing = get_existing(source_file)
    stored_indices = {r["metadata"]["chunk_index"] for r in existing if r.get("metadata") and isinstance(r["metadata"].get("chunk_index"), int)}
    stored_contents = {r["content"] for r in existing if r.get("content")}

    def is_stored(c):
        return c["chunkIndex"] in stored_indices or c["content"] in stored_contents

    if chunks and all(is_stored(c) for c in chunks):
        print(f"  Skipped (already stored): {t['title']}")
        return 0

    stored = 0
    for chunk in chunks:
        if is_stored(chunk):
            continue
        try:
            capture_chunk(chunk["content"], {
                "project": None, "designer": speakers[0] if speakers else None,
                "topics": chunk["topics"], "source_file": source_file,
                "meeting_id": tid, "title": t["title"], "date": date_str,
                "duration": t["duration"], "speakers": speakers,
                "participants": t.get("participants") or [],
                "chunk_index": chunk["chunkIndex"], "total_chunks": len(chunks),
                "is_summary": chunk["isSummary"],
                "start_time": chunk["startTime"], "end_time": chunk["endTime"],
            })
            stored += 1
        except Exception as e:
            print(f"  Failed chunk {chunk['chunkIndex']}: {e}")

    send_notification(
        f"Synced meeting transcript: \"{t['title']}\" ({round(t['duration'])}min, {len(speakers)} speakers). {stored} chunks stored.",
        None
    )
    print(f"  Stored {stored}/{len(chunks)} chunks for \"{t['title']}\"")
    return stored

# --- CLI ---
days = 30
args = sys.argv[1:]
for i, a in enumerate(args):
    if a == "--days" and i+1 < len(args):
        days = int(args[i+1])

print(f"Syncing transcripts from last {days} days...")
transcripts = list_transcripts(days)
print(f"Found {len(transcripts)} transcripts in range.")

total = 0
for t in transcripts:
    print(f"Processing: {t['title']} ({t['id']})")
    total += process(t["id"])

print(f"\nSync complete. {total} total chunks stored from {len(transcripts)} transcripts.")
