# Perry Family Survivor Draft

Season 51 at **https://survivordraft.bensonperry.com**. GitHub Pages serves an explicitly selected static build; a separate Cloudflare Worker and D1 database hold the family league. Clerk has a dedicated application and production domain, independent of Benson's other apps.

## Play

The app opens directly to **Pick 7 people**. Choose from the full original cast and press **Save team**. There is no required team name, separate draft save, or review step. Partial selections persist locally; Save team enters all seven picks. Existing team names are preserved and new teams are named automatically. The best six individual totals count. Navigation has three tabs: My team, Scores, and Episodes; rules and administration are in the footer.

Picking stays open until the commissioner locks it. Picks are private at the API until locked. Ties share ranks. Anyone who signs in with a Clerk account automatically joins the league. Share the regular site URL; no invitation is required. No Gmail access is requested; Google supplies identity only.

## Commissioner

Benson's existing account in the dedicated Clerk application is the commissioner. New accounts always join as regular members. Sign in, then open **Settings** to manage the league.

Use Settings to close/reopen picking, correct cumulative placement and bonus results, and export teams and the change log. Individual immunity wins count; tribal wins and Shots in the Dark do not. A save requires the current record version, so another device cannot silently overwrite a newer save. Incomplete local selections do not enter the standings.

## Automatic results and spoilers

A Cloudflare cron checks the public [survivoR dataset](https://github.com/doehm/survivoR) daily at **8:15 a.m., 12:15 p.m., and 4:15 p.m. America/New_York**, including daylight-saving changes. Only episodes with air dates before the current Eastern date can publish. The extra checks accommodate delayed source updates and changed broadcast nights; availability depends on the upstream dataset. No laptop or manual action is needed.

The importer reads six structured datasets at one immutable Git commit. It validates cast IDs, episode continuity, cast coverage, challenge and idol events, and placements before atomically storing cumulative episode snapshots. Unchanged imports are idempotent. Source outages or validation failures retain the last confirmed results and retry at the next scheduled check. Commissioner corrections live in a separate episode history and carry forward alongside later automatic bonuses. The panel includes a manual check and corrections as fallbacks.

Every person starts **before episode 1**. The **I’ve watched** selector saves progress per Clerk account across devices, or per browser for guests, and never advances automatically. The API projects scores and episode details through that episode; unseen episodes expose only a number and air date. The app starts with a safe cast while identity loads and clears result views before switching accounts or rewinding. **My team** always shows all seven portraits, with score details collapsed. Picking and profile dialogs use the full original roster regardless of watched progress or elimination, preventing eligibility spoilers and allowing late viewers to save normally. The manual closing time is the sole cutoff for changes. Exporting the full league has an explicit spoiler confirmation.

The official cast and fallback premiere snapshot are sourced from the links in `data/s51/season.json`. The legacy wiki scraper is not scheduled and is not used for Season 51. Seasons 49 and 50 remain in `data/` as historical records.

## Development

Node 22+:

```sh
npm ci
npm test
npm run dev
```

Preview: `http://127.0.0.1:4173`. The production Clerk key only works on the production domain; use a dedicated development key for local authentication. Tests use a separate in-memory SQLite database and an injected test authenticator. There is no production authentication bypass.

## Deployment

Pushes to `master` run tests, build the public allowlist, and deploy `dist/` through GitHub Pages. Only public files enter the artifact. Worker changes are deployed separately:

```sh
# Existing installations: additive migration, preserving teams and members.
npx wrangler d1 execute survivor-draft --remote --config worker-v2/wrangler.toml --file worker-v2/migrations/0002_episodes.sql
npm run deploy:api
```

For a new database, use `worker-v2/schema.sql` instead of the migration. Deploy the migrated API before the new frontend. Wrangler registers the hourly UTC trigger; the handler selects the three Eastern check windows. The commissioner panel's **Check for updates** runs the same importer immediately.

The legacy `worker/` and its KV remain untouched. V2 uses `worker-v2/`, its own D1 database, Clerk JWT signature/issuer/time/origin verification, membership checks, optimistic concurrency, and an atomic database lock guard. No Clerk secret key is required: JWTs are verified through the dedicated instance's public JWKS.

Public configuration: `src/config.js`. Server configuration: `worker-v2/wrangler.toml`. Secrets belong in Wrangler, never in this repository. Google OAuth must be configured on the dedicated Clerk production instance with the callback `https://clerk.survivordraft.bensonperry.com/v1/oauth_callback`.

Google production sign-in is configured in the dedicated `perry-family-survivor` Google Cloud project, with basic identity scopes only. Apple production sign-in is enabled in the same Clerk instance, using App ID `com.bensonperry.survivordraft` and Services ID `com.bensonperry.survivordraft.web`. Apple's registered website is `clerk.survivordraft.bensonperry.com`, with the same OAuth callback above. Clerk's private email relay sender is registered with Apple and SPF verified, supporting Hide My Email.

The Apple signing key is stored in Clerk, never in the repository or static build. Keep the Apple Developer membership active and preserve the downloaded key securely; Apple allows only one download. See [Clerk's Apple setup guide](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple) for rotation or reconfiguration.
