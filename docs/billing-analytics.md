# Billing and paywall measurement

## Event contract

New native builds send these events through the existing durable GA4 queue and
`POST /analytics/event`. The GA4 API secret remains on the worker. Billing events
are not forwarded to Meta; existing analysis attribution is unchanged.

| Event | When it occurs | Interpretation |
| --- | --- | --- |
| `allowance_exhausted` | A free analysis consumes the last available monthly credit in a store-capable build | A transition from positive balance to zero, not every app launch or screen render |
| `allowance_blocked` | A subsequent analysis attempt with zero credits invokes the upgrade flow | The monthly limit prompted this paywall attempt; existing users already at zero are included |
| `paywall_requested` | The app calls the native paywall presenter | An opening attempt, not a confirmed impression |
| `paywall_result` | The native presenter resolves/rejects, followed by the entitlement check | `cancelled`, `purchased`, `restored`, `not_presented`, `error`, or `unknown`; `has_pro` independently records the resulting access state |
| `billing_error` | SDK loading, configuration, customer lookup, presentation, or restore fails | Sanitized stage and short code only; also reported as a Sentry billing warning |
| `restore_result` | A restore initiated outside the paywall completes/fails | `completed`, `error`, or `unavailable`, with `has_pro` |

`paywall_source` distinguishes `monthly_limit` from `settings`. The same random
`paywall_flow_id` joins a blocked attempt, request, and result. Concurrent taps
share one native presentation and one set of events. A later attempt gets a new
flow ID.

`presentation_confirmed=true` only follows the SDK's CANCELLED, PURCHASED or
RESTORED result. The current modal API has no on-present callback, so this is
retrospective confirmation after dismissal. A crash/termination while the modal
is open can leave a request without a result. Use RevenueCat impressions for
view measurement; do not label all `paywall_requested` events as views.

The allowance still renews by the device-local calendar month. Instrumentation
does not change when credits are charged, add an unsolicited modal after the
last credit, or migrate historical allowance data.

## GA4 reporting

- Use event count filtered by `event_source=mobile_app_via_worker` and
  `app_platform=ios` or `android` to separate mobile activity from the website.
- Register event-scoped custom dimensions for `paywall_source`, `paywall_result`,
  `billing_stage`, `billing_error_code`, and `app_platform` if not already present.
  This dashboard configuration is separate from delivering the events.
- Do not register random flow IDs as custom dimensions; use raw exported data
  when joining individual attempts is necessary.
- Billing `client_id` is a random app-process/session identifier, with no
  RevenueCat user ID, email, receipt, advertising ID, or persistent device ID.
  GA4 user counts therefore do not measure distinct paying customers. Use
  RevenueCat for customers, subscriptions, and revenue.
- Offline retries retain the original event ID and timestamp. The existing queue
  has a 100-event / 71-hour retention limit and at-least-once delivery: an ACK
  loss can duplicate an event. Deduplicate by `event_id` in raw-data reporting.
- No purchase revenue event is synthesized from a paywall result. Store-verified
  revenue remains the responsibility of RevenueCat/store integrations.

## Rollout and validation

Worker support deployed successfully as Fly release **v44** on September 10,
2026 at 22:32 UTC, preserving the existing machine, volume, and resource limits.
Image digest: `sha256:f295638a4b3c5cc265ff5b774aab67134a3a85f007dd7fa99e730a9c376c12e6`.
The image extends deployed v43 and replaces only `app/main.py` with the analytics
allowlist additions. Removing those additions reproduces the exact production
v43 file hash `4c18e6bae1470b1e28f8d2fd805c9407ffe35ddcc6b2b1a0e7497adc8751ae1a`.
Live `/health` is passing and `/openapi.json` lists all six new event names.
No synthetic event was sent into production GA4. Mobile changes remain local.

Validation: existing app suite plus presenter tests **152 passed**, additional
analytics delivery tests **2 passed**, worker analytics tests **11 passed**,
TypeScript and whitespace checks passed.

Deploy the worker allowlist before releasing the mobile build. Existing app
versions do not emit these new events, and OTA is currently disabled. No past
allowance/paywall events can be reconstructed from this instrumentation.

Tests cover all native presenter results, concurrent taps, thrown errors,
entitlement verification, offline replay, GA4-only billing delivery, worker
forwarding, and rejection of receipt/customer-ID parameters. A store-build
sandbox purchase and restore still need end-to-end validation before describing
the purchase flow as verified.

## Dashboard audit (September 10, 2026)

- Apple in-app purchase and App Store Connect API credentials: valid.
- Apple server notifications: dashboard reports correctly configured.
- Google Play service credentials: valid; both base plans published.
- Current/default offering: `pro_clear_value_draft`, with published Clear Value
  paywall. The identifier's `draft` suffix is not its publication status.
- Google real-time developer notifications: not connected at audit time.
- Historical paywall view count and RTDN setup remain pending access to the
  shared Chrome session; do not report these as verified/configured yet.

References: [RevenueCat presentation API](https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls),
[paywall encounters](https://www.revenuecat.com/docs/dashboard-and-metrics/charts/paywall-encounter-chart),
[Google notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/google-server-notifications).
