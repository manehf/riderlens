# RiderLens — assistant guidelines

## Language

- Conversation may happen in **Portuguese or English** — reply in whichever
  language Antonio uses in his message.
- **Everything in the repository is always English**: code, identifiers,
  comments, commit messages, documentation, and user-facing product copy
  (the app and site ship in English). Never let conversation language leak
  into artifacts.

## Ground rules already established

- One identity everywhere: `com.riderlens.app`.
- Standing product decisions live in `ROADMAP.md` (see "Standing decisions") —
  don't relitigate them casually.
- Store listing copy is pre-drafted in `store/listing.md`; prices live only in
  App Store Connect / Play Console / RevenueCat, never in the repo.
- The worker deploys to Fly independently of app releases — prefer worker-side
  fixes when possible (no store review needed).
