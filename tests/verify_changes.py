"""Render the store at phone + desktop widths and report what the changes look like."""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8791"

async def shot(page, url, path, wait=3500):
    await page.goto(url, wait_until="domcontentloaded")
    await page.wait_for_timeout(wait)
    main = await page.query_selector("main")
    if main:
        await page.evaluate("()=>{const m=document.querySelector('main');m.style.overflowX='visible';m.style.height='auto';}")
        await page.wait_for_timeout(300)
    await page.screenshot(path=path, full_page=True)
    ow = await page.evaluate("()=>{const m=document.querySelector('main');return m?m.scrollWidth:0}")
    iw = await page.evaluate("()=>innerWidth")
    return ow, iw

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])

        # --- phone: discover page, check 2-up tiles ---
        ph = await b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, device_scale_factor=2)
        ow, iw = await shot(ph, BASE + "/", "/tmp/v-discover-390.png")
        print(f"discover 390: main.scrollWidth={ow} innerWidth={iw} overflow={'YES' if ow>iw+1 else 'no'}")

        # measure the actual tile widths in each shelf
        widths = await ph.evaluate("""()=>{
          const out={};
          for (const cls of ['themes-row','plug-row','crypto-row','rows3']) {
            const r=document.querySelector('.'+cls);
            if(!r) continue;
            const k=r.firstElementChild;
            out[cls]= k ? Math.round(k.getBoundingClientRect().width)+'px ('+Math.round(k.getBoundingClientRect().width/innerWidth*100)+'%)' : 'empty';
          }
          return out;
        }""")
        print("tile widths @390:", widths)

        # --- phone: theme page, check gallery ---
        ow, iw = await shot(ph, BASE + "/theme/omarchy-store/", "/tmp/v-theme-390.png")
        g = await ph.evaluate("""()=>{
          const r=document.querySelector('.wall-row');
          if(!r) return 'NO GALLERY';
          const imgs=[...r.querySelectorAll('img')];
          return {cards:imgs.length, loaded:imgs.filter(i=>i.complete&&i.naturalWidth>0).length,
                  firstCaption:(r.querySelector('figcaption')||{}).textContent};
        }""")
        print("theme gallery @390:", g)

        # --- phone: legal dock app page, check Buy button ---
        ow, iw = await shot(ph, BASE + "/app/legal-dock/", "/tmp/v-legaldock-390.png")
        btn = await ph.evaluate("""()=>{
          const b=document.querySelector('[data-buy]');
          return b ? {text:b.textContent.trim(), cls:b.className} : 'NO BUY BUTTON';
        }""")
        print("legal-dock buy button:", btn)
        pay = await ph.evaluate("()=>!!window.OmarchyPay")
        print("OmarchyPay loaded:", pay)

        # --- desktop: theme page gallery + discover ad ---
        dk = await b.new_page(viewport={"width": 1280, "height": 900})
        await shot(dk, BASE + "/theme/omarchy-store/", "/tmp/v-theme-1280.png")
        await shot(dk, BASE + "/", "/tmp/v-discover-1280.png")
        await b.close()

asyncio.run(main())
