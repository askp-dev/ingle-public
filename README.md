# Kioku landing page

The public landing page for Kioku, an audio-first memory assistant for people living with dementia and memory loss. Live at https://kioku.askp.one.

A static single page: `index.html` plus `fonts/` (Kineks Round and Headline One from the Kioku design system, SIL OFL), `audio/` and `voice/` (Wren's lines, recorded with ElevenLabs). Three.js r159 and Source Serif 4 load from public CDNs, so there is no build step.

Music: `audio/ambient-piano.mp3`, "Ambient Piano" by Nikita Kondrashev (leberch) from Pixabay, credited in the page footer.

## Preview

The audio loads via fetch, so serve over http: `python3 -m http.server`, then open http://localhost:8000.

## Deploy

Hosted as a Cloudflare Worker with static assets (`wrangler.jsonc`), on the custom domain `kioku.askp.one`. Files listed in `.assetsignore` are not served.

- Manual: `npx wrangler deploy`
- Automatic: connect this repo in Cloudflare (Workers & Pages, Create, Import a repository). Every push to `main` then redeploys.

Built by [askp](https://askp.one).
