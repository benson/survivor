# Perry Family Survivor Draft

Season 51 at **https://survivordraft.bensonperry.com**. GitHub Pages serves an explicitly selected static build; a separate Cloudflare Worker and D1 database hold the family league. Clerk has a dedicated application and production domain, independent of Benson's other apps.

## Play

Choose seven eligible castaways, name the team, review, and submit. The best six individual totals count. Any number of family members may pick the same castaway. Drafts persist on the device; signed-in members can save them to their account. Drafts and submitted teams are separate. Resubmit edits to enter them.

Picking stays open until the commissioner locks it. Picks are private at the API until locked. Ties share ranks. Family members need a Clerk account and a family invite. No Gmail access is requested; Google supplies identity only.

## Commissioner

Benson's verified Google account in the dedicated Clerk application is the commissioner. The initial bootstrap credential has been retired. Sign in, then open **Commissioner** in the account menu to create a family invitation. Rotating the family invite does not remove existing members.

Use the commissioner panel to lock/reopen picks, record cumulative placement and bonus results, and export teams and the change log. Results recalculate scores immediately. Individual immunity wins count; tribal wins and Shots in the Dark do not. A save requires the current record version, so another device cannot silently overwrite a newer save. Saved drafts do not enter the standings until submitted.

Episode recaps live in `data/s51/episodes.json`. The official cast and Episode 1 results are sourced from the links in `data/s51/season.json`. Subsequent scoring is commissioner-managed. The legacy wiki scraper is not used for Season 51. Seasons 49 and 50 remain in `data/` as historical records.

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
npx wrangler d1 execute survivor-draft --remote --config worker-v2/wrangler.toml --file worker-v2/schema.sql
npm run deploy:api
```

The legacy `worker/` and its KV remain untouched. V2 uses `worker-v2/`, its own D1 database, Clerk JWT signature/issuer/time/origin verification, membership checks, optimistic concurrency, and an atomic database lock guard. No Clerk secret key is required: JWTs are verified through the dedicated instance's public JWKS.

Public configuration: `src/config.js`. Server configuration: `worker-v2/wrangler.toml`. Secrets belong in Wrangler, never in this repository. Google OAuth must be configured on the dedicated Clerk production instance with the callback `https://clerk.survivordraft.bensonperry.com/v1/oauth_callback`.

Google production sign-in is configured in the dedicated `perry-family-survivor` Google Cloud project, with basic identity scopes only. Apple production sign-in is enabled in the same Clerk instance, using App ID `com.bensonperry.survivordraft` and Services ID `com.bensonperry.survivordraft.web`. Apple's registered website is `clerk.survivordraft.bensonperry.com`, with the same OAuth callback above. Clerk's private email relay sender is registered with Apple and SPF verified, supporting Hide My Email.

The Apple signing key is stored in Clerk, never in the repository or static build. Keep the Apple Developer membership active and preserve the downloaded key securely; Apple allows only one download. See [Clerk's Apple setup guide](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple) for rotation or reconfiguration.
