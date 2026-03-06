#!/usr/bin/env python3
"""Playwright probe for hash-nav active-link stability.

Usage:
  python3 scripts/nav-stability-smoke.py [base_url]

Default base_url: http://127.0.0.1:4173/index.html
"""

import asyncio
import sys
from playwright.async_api import async_playwright

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173/index.html"
TARGET_HREF = "/#verification"
INITIAL_SETTLE_MS = 2600
SAMPLE_COUNT = 24
SAMPLE_INTERVAL_MS = 120


async def run_probe(browser_type, name):
    browser = await browser_type.launch()
    page = await browser.new_page(viewport={"width": 1280, "height": 900})
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    await page.click(f'#nav-links a[href="{TARGET_HREF}"]')
    await page.wait_for_timeout(INITIAL_SETTLE_MS)

    samples = []
    unique_sequence = []
    sentinel = object()
    previous = sentinel
    oscillation_edges = 0

    for _ in range(SAMPLE_COUNT):
        active = await page.evaluate(
            """() => {
              const el = document.querySelector('#nav-links a[aria-current="page"]');
              return el ? el.getAttribute('href') : null;
            }"""
        )
        samples.append(active)

        if active != previous:
            unique_sequence.append(active)
            if previous is not sentinel and previous is not None:
                oscillation_edges += 1
        previous = active
        await page.wait_for_timeout(SAMPLE_INTERVAL_MS)

    stable = all(sample == TARGET_HREF for sample in samples)
    print(
        f"{name}: stable={stable} transitions={max(0, len(unique_sequence) - 1)} "
        f"oscillation_edges={oscillation_edges} samples={samples}"
    )

    await browser.close()
    return stable


async def main():
    failures = []
    async with async_playwright() as p:
        for browser_type, name in ((p.chromium, "chromium"), (p.firefox, "firefox"), (p.webkit, "webkit")):
            try:
                ok = await run_probe(browser_type, name)
                if not ok:
                    failures.append(name)
            except Exception as exc:
                failures.append(name)
                print(f"{name}: error={exc}")

    if failures:
        print(f"FAIL: unstable or unavailable browsers: {', '.join(failures)}")
        raise SystemExit(1)

    print("PASS: nav stability confirmed for chromium/firefox/webkit")


if __name__ == "__main__":
    asyncio.run(main())
