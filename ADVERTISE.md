# Advertise on the Omarchy Store

Reach Omarchy and Arch Linux users: developers, creators, and power users who chose their own OS.

## Placements

| Slot | Where it appears | Format |
|---|---|---|
| **Banner** (`banner`) | Discover page, between shelves | Headline, one line of copy, button, brand gradient or image |
| **Sponsored app** (`sponsored-app`) | Top of category pages and search results | Your store listing with an **Ad** badge |
| **Search** (`search`) | Below search results | Compact banner |

Every placement is labelled **Sponsored** or **Ad**. Ads never affect Top Charts or organic ranking.

## Rates and booking

Request a quote at **https://omarchystore.com/advertise/** — pick a placement and dates, add your ad, and you get a private campaign page.
We reply there with a quote; you pay in crypto (USDC, ETH, SOL, BTC or XRP) from the same page, and the payment is confirmed on the
public blockchain automatically. Artwork is copied to our own server, so live ads never load anything from yours.

## What we accept

Developer tools, hardware, hosting, VPNs and privacy tools, Linux-friendly software and services, courses, and conferences.

We don't accept token promotions, gambling, malware or "PC cleaner" type software, or misleading claims.

## Privacy

Direct-sold ads are plain links with UTM tags (`utm_source=omarchy-store`). We run no tracking pixels and set no third-party cookies. If an ad network is enabled, we only use privacy-respecting networks such as [EthicalAds](https://www.ethicalads.io/), which use no cookies and no personal tracking.

---

## For maintainers: running a campaign

Add an entry to [`registry/ads.json`](registry/ads.json) and merge:

```json
{
  "id": "acme-oct-2026",
  "slot": "banner",
  "type": "direct",
  "title": "Acme Cloud — deploy in seconds",
  "body": "Linux-native hosting with a free tier.",
  "cta": "Try Acme",
  "url": "https://acme.example/?ref=omarchy",
  "gradient": ["#1a1b26", "#ff9e64"],
  "starts": "2026-10-01",
  "ends": "2026-10-31"
}
```

Sponsored app listing: `{"id": "...", "slot": "sponsored-app", "type": "app", "app": "<registry id>", "sponsor": "Company", "starts": "...", "ends": "..."}`.

Campaigns turn on and off automatically by date. The weekly rebuild drops expired ones, and you can trigger a rebuild manually from the Actions tab.

**Ad network fallback:** set `network.enabled: true` and `network.publisher_id` once you have an EthicalAds publisher account. Network ads fill the banner slot whenever no direct campaign is running.
