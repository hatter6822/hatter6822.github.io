#!/usr/bin/env python3
"""Playwright smoke probe for hash-nav active-link stability.

Usage:
  python3 scripts/nav-stability-smoke.py [base_url]

Default base_url: http://127.0.0.1:4173/index.html
"""

import asyncio
import sys
from playwright.async_api import async_playwright

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173/index.html"
TARGET_HREF = "/#verification"


async def run_probe(browser_type, name):
    browser = await browser_type.launch()
    page = await browser.new_page(viewport={"width": 1280, "height": 900})
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    await page.click(f'#nav-links a[href="{TARGET_HREF}"]')
    await page.wait_for_timeout(2600)

    samples = []
    for _ in range(10):
        active = await page.evaluate(
            """() => {
              const el = document.querySelector('#nav-links a[aria-current="page"]');
              return el ? el.getAttribute('href') : null;
            }"""
        )
        samples.append(active)
        await page.wait_for_timeout(120)

    stable = all(sample == TARGET_HREF for sample in samples)
    print(f"{name}: stable={stable} samples={samples}")

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
