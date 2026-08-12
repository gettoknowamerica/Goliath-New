#!/usr/bin/env python3
"""Scrape a URL locally with Trafilatura and print the extracted text to stdout.

Usage: scripts/scrape_url.py <url>

Used by src/enrich.ts (scrapeTrafilatura) to add real page scraping to the
free DuckDuckGo enrichment path, replacing the paid Firecrawl scrape step.

Behavior:
- Fetches the page with trafilatura.fetch_url (urllib3 pool, DOWNLOAD_TIMEOUT=20s).
- Extracts main content with trafilatura.extract.
- Prints the extracted text to stdout (UTF-8).
- On ANY failure (bad URL, fetch error, empty extraction) prints NOTHING and
  exits 0 — the caller treats empty output as "no usable text". It never hangs
  forever: the fetch is bounded by DOWNLOAD_TIMEOUT and the parent kills the
  process after 25s via execFile timeout.
"""
import copy
import sys

import trafilatura
from trafilatura.settings import DEFAULT_CONFIG

DOWNLOAD_TIMEOUT_S = 20


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    url = sys.argv[1].strip()
    if not url.startswith(("http://", "https://")):
        return 0
    # trafilatura.fetch_url reads DOWNLOAD_TIMEOUT (and MAX_FILE_SIZE etc.) from
    # the "DEFAULT" section of the config it is given (downloads.py:
    # _send_urllib_request / _initiate_pool). Start from the bundled defaults
    # and override only the timeout so every other required option stays set.
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg.set("DEFAULT", "DOWNLOAD_TIMEOUT", str(DOWNLOAD_TIMEOUT_S))
    try:
        downloaded = trafilatura.fetch_url(url, config=cfg)
        if not downloaded:
            return 0
        text = trafilatura.extract(downloaded)
        if text:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stdout.write(text)
    except Exception:
        # Empty output signals "no scrape" to the caller; never crash.
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
