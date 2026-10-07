"""Post a short release announcement to Bluesky.

Reads the release (tag, url, body) as JSON from stdin, e.g. from
`gh release view <tag> --json tagName,url,body`. The post is the first
paragraph of the release notes plus the link and a preview card. Notes containing
<!-- no-social --> are skipped. DRY_RUN=true logs in (if credentials are set)
and prints the post without publishing it.
"""
import json
import os
import re
import sys
import time
import urllib.error
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


def xrpc(method: str, payload: dict | bytes, token: str | None = None, content_type: str = "application/json") -> dict:
    req = urllib.request.Request(
        f"https://bsky.social/xrpc/{method}",
        data=payload if isinstance(payload, bytes) else json.dumps(payload).encode(),
        headers={"Content-Type": content_type, **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def fetch(url: str, retries: int = 2) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "webspeak3-release-announcer"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.read(), res.headers.get_content_type()
    except urllib.error.HTTPError as err:
        if err.code != 429 or not retries:  # GitHub's image service throttles bursts now and then
            raise
        time.sleep(10)
        return fetch(url, retries - 1)


def link_card(release: dict, text: str) -> dict:
    """The preview card the Bluesky app would show for a pasted link. The API doesn't build one itself.
    The image is GitHub's own social preview for the release page. Its URL takes any cache-busting
    segment, so we don't have to scrape the release page (GitHub rate-limits that)."""
    url = release["url"]
    card = {"uri": url, "title": f"WebSpeak3 {release['tagName']}",
            "description": text.split("\n\n")[0].split(": ", 1)[-1]}
    path = url.removeprefix("https://github.com/")
    image, mime = fetch(f"https://opengraph.githubassets.com/{release['tagName']}/{path}")
    if len(image) <= 1_000_000:  # Bluesky's blob limit for thumbnails
        card["image"] = (image, mime)
    return card


def main() -> None:
    release = json.load(sys.stdin)
    text = build_post(release)
    if text is None:
        print("Release notes contain <!-- no-social -->, skipping.")
        return
    print(text)
    url = release["url"]
    try:
        card = link_card(release, text)
        print(f"Link card: {card['title']} (image: {len(card['image'][0]) if 'image' in card else 'none'} bytes)")
    except Exception as err:  # a missing preview shouldn't cost us the post
        print(f"No link card: {err}")
        card = None

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
    if card:
        external = {"uri": card["uri"], "title": card["title"], "description": card["description"]}
        if "image" in card:
            image, mime = card["image"]
            external["thumb"] = xrpc("com.atproto.repo.uploadBlob", image, session["accessJwt"], mime)["blob"]
        record["embed"] = {"$type": "app.bsky.embed.external", "external": external}
    post = xrpc("com.atproto.repo.createRecord",
                {"repo": session["did"], "collection": "app.bsky.feed.post", "record": record},
                session["accessJwt"])
    print(f"Posted: {post['uri']}")


if __name__ == "__main__":
    main()
