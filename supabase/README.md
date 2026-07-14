# RiderLens Supabase

The production schema is managed only through ordered SQL migrations in
`supabase/migrations`. Do not create or edit production tables in the Dashboard;
that bypasses Supabase's migration history.

## Link the production project

From the repository root:

```bash
npx supabase@latest login
npx supabase@latest link --project-ref hodycggzravwyzkbnjiy
npx supabase@latest db push --dry-run
npx supabase@latest db push
```

The link command prompts for the database password created with the project.
Keep that password and the Supabase secret key out of the repository.

## Initial production resources

The first migration creates:

- `profiles`
- `analysis_sessions`
- `analysis_jobs`
- One private `analysis-media` Storage bucket
- Owner-only table and Storage RLS policies
- A profile trigger for new authenticated users

Media object keys follow this shape:

```text
<user-id>/<analysis-session-id>/source.mp4
<user-id>/<analysis-session-id>/clean.mp4
<user-id>/<analysis-session-id>/skeleton.mp4
<user-id>/<analysis-session-id>/poster.jpg
<user-id>/<analysis-session-id>/analysis.json
<user-id>/<analysis-session-id>/frames.zip
```

The mobile app may upload only `source.mp4` or `source.mov` for a session that
the server has approved. The worker uses `SUPABASE_SECRET_KEY` to write generated
assets, update job state, and coordinate deletion.

## Verification

After a push, confirm in the Dashboard:

1. The three public tables show RLS enabled.
2. `analysis-media` exists and is private.
3. No policies grant access to the `anon` database role.
4. The Security Advisor has no exposed-table findings for these resources.
