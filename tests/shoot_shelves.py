"""Screenshot the specific shelves so we can eyeball the two-up tiles and the gallery."""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8791"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        ph = await b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, device_scale_factor=2)

        await ph.goto(BASE + "/", wait_until="domcontentloaded")
        await ph.wait_for_timeout(4000)
        # dismiss the desktop-app upsell banner if present
        await ph.evaluate("""()=>{document.querySelectorAll('.upsell,.native-banner,[class*=upgrade]').forEach(e=>e.remove());}""")

        # screenshot each shelf that holds the small square tiles
        for cls, name in [("themes-row", "themes"), ("plug-row", "plugins"), ("crypto-row", "crypto")]:
            el = await ph.query_selector("." + cls)
            if not el:
                print(f"{name}: shelf not found"); continue
            sec = await el.evaluate_handle("e=>e.closest('section')||e.parentElement")
            await sec.as_element().scroll_into_view_if_needed()
            await ph.wait_for_timeout(1200)
            await sec.as_element().screenshot(path=f"/tmp/s-{name}-390.png")
            w = await el.evaluate("e=>{const k=e.firstElementChild;return k?Math.round(k.getBoundingClientRect().width):0}")
            print(f"{name}: tile {w}px of {390} = {round(w/390*100)}%")

        # the sponsor ad
        ad = await ph.query_selector(".artist-ad")
        if ad:
            await ad.scroll_into_view_if_needed(); await ph.wait_for_timeout(900)
            await ad.screenshot(path="/tmp/s-ad-390.png"); print("ad: captured")

        # theme page gallery
        await ph.goto(BASE + "/theme/omarchy-store/", wait_until="domcontentloaded")
        await ph.wait_for_timeout(4000)
        g = await ph.query_selector(".wall-row")
        if g:
            sec = await g.evaluate_handle("e=>e.closest('section')")
            await sec.as_element().scroll_into_view_if_needed(); await ph.wait_for_timeout(2500)
            await sec.as_element().screenshot(path="/tmp/s-gallery-390.png"); print("gallery: captured")

        # legal dock buy button
        await ph.goto(BASE + "/app/legal-dock/", wait_until="domcontentloaded")
        await ph.wait_for_timeout(4000)
        bb = await ph.query_selector("[data-buy]")
        if bb:
            head = await bb.evaluate_handle("e=>e.closest('.detail-head')||e.parentElement")
            await head.as_element().screenshot(path="/tmp/s-buy-390.png"); print("buy button: captured")

        # desktop gallery
        dk = await b.new_page(viewport={"width": 1280, "height": 900})
        await dk.goto(BASE + "/theme/omarchy-store/", wait_until="domcontentloaded")
        await dk.wait_for_timeout(4000)
        g = await dk.query_selector(".wall-row")
        if g:
            sec = await g.evaluate_handle("e=>e.closest('section')")
            await sec.as_element().scroll_into_view_if_needed(); await dk.wait_for_timeout(2500)
            await sec.as_element().screenshot(path="/tmp/s-gallery-1280.png"); print("gallery desktop: captured")
        await b.close()

asyncio.run(main())
