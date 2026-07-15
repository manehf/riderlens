# RiderLens — Store Listing Package

Everything the store forms ask for, pre-drafted. Character limits verified.
Review before submitting; prices/product names live in App Store Connect /
Play Console / RevenueCat, not here.

---

## Identity

| Field | Value |
|---|---|
| App name (both stores) | RiderLens: MTB Skills Analysis |
| iOS subtitle (max 30 chars) | See your riding frame by frame |
| Play short description (max 80 chars) | Film your riding. See your body position on every frame. Built for MTB. |
| Category | Sports (iOS secondary: Photo & Video) |
| Support URL | https://riderlens.app |
| Marketing URL | https://riderlens.app |
| Privacy policy URL | https://riderlens.app/privacy |
| Terms of use URL | https://riderlens.app/terms |
| Support email | hello@riderlens.app |

## iOS promotional text (max 170 chars)

> See exactly what happened at takeoff. RiderLens draws your body position on
> every frame of your ride — step through it, slow it down, share the send.

## Description (both stores)

> **See your riding, frame by frame.**
>
> Film your riding with your phone's camera, pick the clip in RiderLens, and
> get back a record you can study: your body position drawn on every frame,
> airtime and height estimates on jumps, and playback built for analysis —
> frame stepping, slow motion, fullscreen.
>
> **How it works**
> 1. Film with your camera app — from the side, whole rider in frame
> 2. Pick the clip and select the moment (up to 8 seconds)
> 3. RiderLens analyzes every frame and draws your body position
> 4. Study it, compare attempts, share the send
>
> **Built for gravity riding**
> • Skeleton overlay on every frame — see hips, knees, and arms through
>   every move, from takeoff to landing
> • Airtime and height estimates for jumps
> • Frame-by-frame stepping and ¼-speed slow motion
> • Your library of moments — tagged, searchable, on your phone
> • Share clips with the skeleton burned in
>
> **Private by design**
> Your videos and records stay on your phone. Clips are uploaded only for
> processing and deleted from our servers shortly after. No account needed.
>
> **Free and Pro**
> Analyze 3 clips every month for free. RiderLens Pro unlocks unlimited
> analyses.
>
> Ride within your limits. RiderLens shows what happened — it doesn't make
> the send safe.

## iOS keywords (max 100 chars)

```
mountain bike,video analysis,slow motion,airtime,downhill,enduro,dirt jump,bike,skeleton,whip,drop
```
(98 chars — `mtb`/`jump` live in the app name; `dirt jump` keeps the jump token)

---

## Age rating

- **Apple questionnaire:** all content descriptors "None". Unrestricted web
  access: No. Gambling: No. Result: **4+**.
- **Play content rating (IARC):** no violence/sexuality/profanity/controlled
  substances; no user-generated content shared publicly inside the app; no
  location sharing. Result: **Everyone / PEGI 3**.
- Extreme-sports footage the rider films themselves is not "realistic
  violence" under either questionnaire.

## Apple privacy nutrition label

Declare **only**:

| Data type | Linked to identity? | Used for tracking? | Purpose |
|---|---|---|---|
| Diagnostics → Crash Data | No | No | App functionality |

Reasoning (keep for review responses): videos are transmitted for processing
but deleted within ~45 minutes and never linked to an identity — under
Apple's definition ("retained longer than necessary to service the request")
this is not "collection". There are no accounts, no analytics, no ads, no
tracking. Sentry crash reports are configured without PII (no IP-based
identity, no media attached).

## Play Data Safety form

- **Data collected:** App info and performance → Crash logs, Diagnostics.
  Collection is optional? No (automatic). Encrypted in transit: Yes. Users
  can request deletion: Yes (via hello@riderlens.app).
- **Video processing:** declare as *processed ephemerally* (uploaded for
  analysis, deleted shortly after, never stored server-side) — the form has
  an explicit ephemeral-processing concept that fits exactly.
- **Data shared with third parties:** none. (Sentry acts as a service
  provider/processor for crash data, not "sharing" under Play's definition.)
- No ads SDK, no location, no personal identifiers.

---

## App Review notes (paste into both stores)

> RiderLens analyzes short mountain-bike videos: it finds the rider in each
> frame and draws their body position (pose skeleton) for frame-by-frame
> review.
>
> **To test:** film any person riding a bicycle (or any short video with one
> visible person on a bike — a few seconds is enough), then in RiderLens tap
> (+), pick the clip, select the moment, and tap Analyze. Processing
> runs on our server and takes roughly 20–60 seconds; the very first request
> after idle may add ~20 seconds while the server wakes.
>
> **No account is needed.** The free tier includes 3 analyses per month;
> RiderLens Pro (auto-renewable subscription) unlocks unlimited analyses.
> Restore Purchases is in Settings.
>
> Videos are uploaded only for processing and deleted from the server within
> ~45 minutes. The app works without any sign-in.

## Screenshot shot list (once builds exist)

Same six shots per platform, portrait:

1. Home grid with several records (poster tiles + tags)
2. Skeleton playback mid-air, phase banner visible ("PEAK AIR")
3. Trim sheet — "select the moment" with thumbnails
4. Frame stepping close-up (transport row + filmstrip)
5. Fullscreen landscape playback
6. Record with airtime/height chips + share sheet

Sizes: iOS 6.9" (1320×2868) and 6.5" (1284×2778); Play phone screenshots
(min 1080px wide) + 1024×500 feature graphic.

---

## Subscription metadata (App Store Connect / Play Console)

| Field | Value |
|---|---|
| Subscription group (iOS) | RiderLens Pro |
| Display name | RiderLens Pro |
| Products | Monthly + Annual (IDs already in RevenueCat: `riderlens.pro.monthly` / `riderlens.pro.annual`, Play: `riderlens_pro_v1` monthly/annual base plans) |
| Benefit copy | Unlimited analyses. All playback and sharing features stay free. |

Apple requires the paywall to show: price, period, and functional links to
the privacy policy and terms — the RevenueCat paywall template handles this;
verify before submission.
