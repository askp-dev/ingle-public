# Ingle landing page

The public landing page for Ingle, an audio-first memory assistant for people living with dementia and memory loss. Live at https://ingle.askp.one.

A static single page: `index.html` plus `fonts/` (Kineks Round and Headline One from the Ingle design system, SIL OFL), `audio/` and `voice/` (Wren's lines, recorded with ElevenLabs). Three.js r159 and Source Serif 4 load from public CDNs, so there is no build step.

Music: `audio/ambient-piano.mp3`, "Ambient Piano" by Nikita Kondrashev (leberch) from Pixabay, credited in the page footer.

## Workflow demo (/demo, password protected)

`demo/` is a browser simulation of one day with Ingle: scripted glasses and sensor events go through on-device face matching, the verified truth store (JSON) and the deterministic orchestrator (confidence gate, cooldowns, interruption budget, priority tiers), and end as one line from Wren or silence. Every decision is logged with its reason. The orchestrator mirrors the Kotlin one in `askp-dev/kioku-android`.

`worker/index.js` gates `/demo` and everything under it (`run_worker_first` in `wrangler.jsonc`); every other path is served straight from static assets. The password is only ever a Worker secret, never in this repo:

- `DEMO_PASSWORD` (required): the shared password. Until it is set, `/demo` stays locked.
- `DEMO_SESSION_SECRET` (optional): a long random string to sign the session cookie. Without it the password is the signing key, so changing the password signs everyone out.

Set them in Cloudflare (Workers & Pages, kioku-public, Settings, Variables and Secrets, add as Secret) or with `npx wrangler secret put DEMO_PASSWORD`. A correct password sets an HttpOnly, Secure cookie holding an expiry and an HMAC-SHA256 signature, valid for 7 days. `/demo/logout` signs out.

Local preview of the demo: put `DEMO_PASSWORD=anything` in `.dev.vars` (git-ignored) and run `npx wrangler dev`.

## Preview

The audio loads via fetch, so serve over http: `python3 -m http.server`, then open http://localhost:8000.

## Deploy

Hosted as a Cloudflare Worker with static assets (`wrangler.jsonc`), on the custom domain `ingle.askp.one`. Files listed in `.assetsignore` are not served.

- Manual: `npx wrangler deploy`
- Automatic: connect this repo in Cloudflare (Workers & Pages, Create, Import a repository). Every push to `main` then redeploys.

Built by [askp](https://askp.one).
