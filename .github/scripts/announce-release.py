"""Post a short release announcement to Bluesky.

Reads the release (tag, url, body) as JSON from stdin, e.g. from
`gh release view <tag> --json tagName,url,body`. The post is the first
paragraph of the release notes plus the link. Notes containing
<!-- no-social --> are skipped. DRY_RUN=true logs in (if credentials are set)
and prints the post without publishing it.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

BLUESKY_LIMIT = 300


def build_post(release: dict) -> str | None:
    body = release.get("body") or ""
    if "<!-- no-social -->" in body:
        return None
    summary = body.strip().split("\n\n")[0].strip()
    if summary.startswith("#"):
        summary = ""
    summary = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", summary)
    summary = " ".join(re.sub(r"[`*_]", "", summary).split())
    head = f"WebSpeak3 {release['tagName']}"
    tail = f"\n\n{release['url']}"
    room = BLUESKY_LIMIT - len(head) - len(tail) - 2
    if len(summary) > room:
        # Prefer dropping whole sentences over cutting one off mid-word.
        cut = summary[:room].rfind(". ")
        summary = summary[: cut + 1] if cut > 0 else summary[: room - 1].rstrip() + "…"
    return f"{head}: {summary}{tail}" if summary else head + tail


def xrpc(method: str, payload: dict, token: str | None = None) -> dict:
    req = urllib.request.Request(
        f"https://bsky.social/xrpc/{method}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def main() -> None:
    release = json.load(sys.stdin)
    text = build_post(release)
    if text is None:
        print("Release notes contain <!-- no-social -->, skipping.")
        return
    print(text)

    dry_run = os.environ.get("DRY_RUN") == "true"
    handle, password = os.environ.get("BLUESKY_HANDLE"), os.environ.get("BLUESKY_APP_PASSWORD")
    if not password:
        sys.exit(0 if dry_run else "BLUESKY_APP_PASSWORD is not set.")
    session = xrpc("com.atproto.server.createSession", {"identifier": handle, "password": password})
    print(f"Logged in as {session['handle']}.")
    if dry_run:
        print("Dry run, not posting.")
        return

    # Bluesky doesn't auto-link URLs in API posts; the link needs a facet with UTF-8 byte offsets.
    url = release["url"]
    start = len(text[: text.rindex(url)].encode())
    record = {
        "$type": "app.bsky.feed.post",
        "text": text,
        "langs": ["en"],
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "facets": [{
            "index": {"byteStart": start, "byteEnd": start + len(url.encode())},
            "features": [{"$type": "app.bsky.richtext.facet#link", "uri": url}],
        }],
    }
    post = xrpc("com.atproto.repo.createRecord",
                {"repo": session["did"], "collection": "app.bsky.feed.post", "record": record},
                session["accessJwt"])
    print(f"Posted: {post['uri']}")


if __name__ == "__main__":
    main()
