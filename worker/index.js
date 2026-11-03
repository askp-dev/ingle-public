/*
 * Ingle site Worker.
 *
 * Everything is served from static assets, except /demo, which sits behind a password.
 * The password lives only in the Worker secret DEMO_PASSWORD (set in the Cloudflare dashboard
 * or with `npx wrangler secret put DEMO_PASSWORD`). It is never in the repo or in client JS.
 *
 * Flow: GET /demo without a valid cookie returns a small sign-in page (401). The form posts to
 * /demo/login; on a match the Worker sets an HttpOnly cookie holding an expiry time and an
 * HMAC-SHA256 signature of it, then redirects to /demo/. Every /demo request checks that
 * signature before the static demo files are served. With no secret set, /demo stays locked.
 *
 * The signing key is DEMO_SESSION_SECRET when set, otherwise DEMO_PASSWORD, so changing the
 * password signs everyone out.
 */

const COOKIE = "ingle_demo";
const SESSION_DAYS = 7;
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path !== "/demo" && !path.startsWith("/demo/")) return env.ASSETS.fetch(request);

    const password = env.DEMO_PASSWORD;
    if (!password) return page(signInHtml({ locked: true }), 503);

    if (path === "/demo/logout") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/demo/", "Set-Cookie": `${COOKIE}=; Path=/demo; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, ...privateHeaders() },
      });
    }

    if (path === "/demo/login" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const given = form ? String(form.get("password") || "") : "";
      if (await sameSecret(given, password)) {
        const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
        const token = `${exp}.${await sign(String(exp), signingKey(env))}`;
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/demo/",
            "Set-Cookie": `${COOKIE}=${token}; Path=/demo; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
            ...privateHeaders(),
          },
        });
      }
      await new Promise((r) => setTimeout(r, 700)); // slow down guessing
      return page(signInHtml({ wrong: true }), 401);
    }

    const signedIn = await validCookie(request, env);
    if (path === "/demo/login") {
      return signedIn ? redirect("/demo/") : page(signInHtml({}), 401);
    }
    if (!signedIn) return page(signInHtml({}), 401);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(privateHeaders())) out.headers.set(k, v);
    return out;
  },
};

function signingKey(env) {
  return env.DEMO_SESSION_SECRET || env.DEMO_PASSWORD;
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function sign(value, secret) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(value));
  return b64url(new Uint8Array(sig));
}

async function validCookie(request, env) {
  const raw = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  let bytes;
  try { bytes = fromB64url(sig); } catch { return false; }
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(signingKey(env), "verify"), bytes, enc.encode(exp));
}

/** Constant-time comparison of two strings, via their SHA-256 digests (equal length). */
async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function privateHeaders() {
  return { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" };
}

function redirect(to) {
  return new Response(null, { status: 303, headers: { Location: to, ...privateHeaders() } });
}

function page(html, status) {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...privateHeaders() } });
}

function signInHtml({ wrong = false, locked = false }) {
  const note = locked
    ? `<p class="note">The demo isn't switched on yet. The site owner needs to set its password.</p>`
    : wrong
      ? `<p class="note err" role="alert">That password didn't match. Try again.</p>`
      : `<p class="note">This walkthrough is shared privately. Enter the password you were given.</p>`;
  const form = locked ? "" : `
    <form method="post" action="/demo/login">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Open the demo</button>
    </form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Ingle demo</title>
<style>
@font-face { font-family: "Kineks Round"; src: url("/fonts/KineksRound-SemiBold.otf") format("opentype"); font-weight: 600; font-display: swap; }
@font-face { font-family: "Kineks Round"; src: url("/fonts/KineksRound-Bold.otf") format("opentype"); font-weight: 700; font-display: swap; }
:root { --ground: #d4d7cb; --panel: #efede6; --surface: #fbfaf6; --ink: #1b211a; --muted: #5c6359; --line: #c9cdbf; --control: #8a9183; --moss-deep: #4f6a33; --amber: #ffa700; --danger: #a8452c; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --ground: #111510; --panel: #1b211a; --surface: #232a21; --ink: #f3ead6; --muted: #a3a99f; --line: #3a4636; --control: #6f7a69; --moss-deep: #8bae66; --danger: #e48a6f; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--ground); color: var(--ink); font-family: Georgia, "Times New Roman", serif; }
main { width: 100%; max-width: 420px; background: var(--panel); border-radius: 20px; padding: 32px 28px; display: grid; gap: 18px; }
.brand { font-family: "Kineks Round", system-ui, sans-serif; font-weight: 700; letter-spacing: 0.08em; font-size: 18px; }
h1 { margin: 0; font-family: "Kineks Round", system-ui, sans-serif; font-weight: 700; font-size: 24px; line-height: 30px; }
.note { margin: 0; color: var(--muted); font-size: 16px; line-height: 24px; }
.err { color: var(--danger); }
form { display: grid; gap: 8px; }
label { font-family: "Kineks Round", system-ui, sans-serif; font-weight: 600; font-size: 13px; }
input { font: inherit; font-size: 16px; padding: 10px 12px; border-radius: 10px; border: 1.5px solid var(--control); background: var(--surface); color: var(--ink); }
input:focus { outline: none; border-color: var(--moss-deep); box-shadow: 0 0 0 3px var(--amber); }
button { margin-top: 8px; font-family: "Kineks Round", system-ui, sans-serif; font-weight: 600; font-size: 15px; padding: 11px 18px; border: 0; border-radius: 12px; background: var(--amber); color: #1b211a; cursor: pointer; }
button:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
a { color: inherit; }
.foot { font-size: 14px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="brand">INGLE</div>
  <h1>Workflow demo</h1>
  ${note}${form}
  <p class="foot"><a href="/">Back to ingle.askp.one</a></p>
</main>
</body>
</html>`;
}
