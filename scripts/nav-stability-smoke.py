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
INITIAL_SETTLE_MS = 2800
SAMPLE_COUNT = 32
SAMPLE_INTERVAL_MS = 90
LAYOUT_SHIFT_TARGET = "/#verification"
LAYOUT_SHIFT_HEIGHT_PX = 260

TARGET_HREFS = (
    "/#features",
    "/#security",
    "/#verification",
    "/#getting-started",
)
REPEATED_TARGET = "/#verification"
REPEATED_CLICKS = 3
STRESS_SEQUENCE = (
    "/#features",
    "/#security",
    "/#verification",
    "/#getting-started",
    "/#security",
    "/#features",
    "/#verification",
)
STRESS_CLICK_GAP_MS = 120


async def sample_nav_state(page, target_href):
    samples = []
    unique_sequence = []
    previous = None

    for _ in range(SAMPLE_COUNT):
        snapshot = await page.evaluate(
            """(targetHref) => {
              const active = document.querySelector('#nav-links a[aria-current="page"]');
              const activeHref = active ? active.getAttribute('href') : null;
              const activeHash = activeHref && activeHref.includes('#') ? activeHref.slice(activeHref.indexOf('#')) : null;
              const targetHash = targetHref.includes('#') ? targetHref.slice(targetHref.indexOf('#')) : '';
              const target = targetHash ? document.querySelector(targetHash) : null;
              if (!target) {
                return { activeHref, activeHash, targetHash, inFocus: null, top: null };
              }

              const nav = document.getElementById('nav');
              const navHeight = nav ? Math.ceil(nav.getBoundingClientRect().height || 0) : 0;
              const top = Math.round(target.getBoundingClientRect().top);
              const minTop = navHeight - 6;
              const maxTop = navHeight + 80;
              let activeInFocus = null;
              if (activeHash) {
                const activeTarget = document.querySelector(activeHash);
                if (activeTarget) {
                  const activeTop = Math.round(activeTarget.getBoundingClientRect().top);
                  activeInFocus = activeTop >= minTop && activeTop <= maxTop;
                }
              }
              return {
                activeHref,
                activeHash,
                targetHash,
                inFocus: top >= minTop && top <= maxTop,
                activeInFocus,
                top,
              };
            }""",
            target_href,
        )
        samples.append(snapshot)
        if snapshot["activeHref"] != previous:
            unique_sequence.append(snapshot["activeHref"])
        previous = snapshot["activeHref"]
        await page.wait_for_timeout(SAMPLE_INTERVAL_MS)

    active_stable = all(s["activeHref"] == target_href for s in samples)
    focus_stable = all(s.get("inFocus") is True for s in samples if s.get("inFocus") is not None)
    active_focus_consistent = all(
        s.get("activeInFocus") is True for s in samples if s.get("activeInFocus") is not None
    )
    return {
        "target": target_href,
        "samples": samples,
        "active_stable": active_stable,
        "focus_stable": focus_stable,
        "active_focus_consistent": active_focus_consistent,
        "transitions": max(0, len(unique_sequence) - 1),
    }




async def induce_layout_shift(page, shift_height):
    await page.evaluate(
        """(height) => {
          let probe = document.getElementById('nav-stability-layout-probe');
          if (!probe) {
            probe = document.createElement('div');
            probe.id = 'nav-stability-layout-probe';
            probe.setAttribute('aria-hidden', 'true');
            probe.style.width = '100%';
            probe.style.pointerEvents = 'none';
            probe.style.transition = 'height 120ms linear';
            const about = document.getElementById('about');
            if (about && about.parentNode) about.parentNode.insertBefore(probe, about);
            else document.body.insertBefore(probe, document.body.firstChild);
          }
          probe.style.height = `${Math.max(0, Number(height) || 0)}px`;
        }""",
        shift_height,
    )

async def run_probe(browser_type, name):
    browser = await browser_type.launch()
    page = await browser.new_page(viewport={"width": 1280, "height": 900})
    await page.goto(BASE_URL, wait_until="domcontentloaded")

    failures = []
    for href in TARGET_HREFS:
        await page.click(f'#nav-links a[href="{href}"]')
        await page.wait_for_timeout(INITIAL_SETTLE_MS)
        result = await sample_nav_state(page, href)
        passed = result["active_stable"] and result["focus_stable"] and result["active_focus_consistent"]
        print(
            f"{name}: target={href} pass={passed} transitions={result['transitions']} "
            f"active_stable={result['active_stable']} focus_stable={result['focus_stable']} active_focus_consistent={result['active_focus_consistent']}"
        )
        if not passed:
            failures.append(result)

    # Dynamic layout-shift regression: same active link should remain stable after asynchronous geometry changes.
    await page.click(f'#nav-links a[href="{LAYOUT_SHIFT_TARGET}"]')
    await page.wait_for_timeout(INITIAL_SETTLE_MS)
    await induce_layout_shift(page, LAYOUT_SHIFT_HEIGHT_PX)
    await page.wait_for_timeout(260)
    layout_result = await sample_nav_state(page, LAYOUT_SHIFT_TARGET)
    layout_passed = layout_result["active_stable"] and layout_result["focus_stable"] and layout_result["active_focus_consistent"]
    print(
        f"{name}: layout-shift target={LAYOUT_SHIFT_TARGET} pass={layout_passed} transitions={layout_result['transitions']} "
        f"active_stable={layout_result['active_stable']} focus_stable={layout_result['focus_stable']} active_focus_consistent={layout_result['active_focus_consistent']}"
    )
    if not layout_passed:
        failures.append(layout_result)

    # Repeated-click regression: same link selected multiple times should not oscillate after settle.
    for repeat_index in range(REPEATED_CLICKS):
        await page.click(f'#nav-links a[href="{REPEATED_TARGET}"]')
        await page.wait_for_timeout(INITIAL_SETTLE_MS)
        result = await sample_nav_state(page, REPEATED_TARGET)
        passed = result["active_stable"] and result["focus_stable"] and result["active_focus_consistent"]
        print(
            f"{name}: repeated target={REPEATED_TARGET} run={repeat_index + 1}/{REPEATED_CLICKS} "
            f"pass={passed} transitions={result['transitions']} active_stable={result['active_stable']} "
            f"focus_stable={result['focus_stable']} active_focus_consistent={result['active_focus_consistent']}"
        )
        if not passed:
            failures.append(result)

    # Stress regression: rapid alternating clicks must converge to the final target
    # without post-settle oscillation of aria-current.
    for href in STRESS_SEQUENCE:
        await page.click(f'#nav-links a[href="{href}"]')
        await page.wait_for_timeout(STRESS_CLICK_GAP_MS)

    final_target = STRESS_SEQUENCE[-1]
    await page.wait_for_timeout(INITIAL_SETTLE_MS)
    stress_result = await sample_nav_state(page, final_target)
    stress_passed = stress_result["active_stable"] and stress_result["focus_stable"] and stress_result["active_focus_consistent"]
    print(
        f"{name}: stress final_target={final_target} pass={stress_passed} transitions={stress_result['transitions']} "
        f"active_stable={stress_result['active_stable']} focus_stable={stress_result['focus_stable']} active_focus_consistent={stress_result['active_focus_consistent']}"
    )
    if not stress_passed:
        failures.append(stress_result)

    await browser.close()
    return failures


async def main():
    failures = []
    async with async_playwright() as p:
        for browser_type, name in ((p.chromium, "chromium"), (p.firefox, "firefox"), (p.webkit, "webkit")):
            try:
                browser_failures = await run_probe(browser_type, name)
                if browser_failures:
                    failures.append((name, browser_failures))
            except Exception as exc:
                failures.append((name, [{"error": str(exc)}]))
                print(f"{name}: error={exc}")

    if failures:
        for browser, browser_failures in failures:
            print(f"FAIL {browser}: {browser_failures}")
        raise SystemExit(1)

    print("PASS: nav stability confirmed across links, dynamic layout-shift, and repeated-click regressions for chromium/firefox/webkit")


if __name__ == "__main__":
    asyncio.run(main())
