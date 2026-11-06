// Cloudflare Worker that serves every customer's site. The `app` Cloud Function uploads this
// file to Cloudflare (Admin -> Setup -> Set up site hosting) and attaches each customer's
// domain to it. Pages live in the SITES KV namespace under "site:<domain>".

const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function note(status, title, body) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBF7F0;color:#141210;font:17px/1.5 system-ui,sans-serif;padding:24px;box-sizing:border-box;text-align:center}
main{max-width:460px}h1{font-size:1.5rem;margin:0 0 .5rem}a{color:#B3261E;font-weight:700}</style></head>
<body><main><h1>${esc(title)}</h1><p>${body}</p></main></body></html>`;
  return new Response(html, { status, headers: { ...HEADERS, "cache-control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      return Response.redirect(`https://${host.slice(4)}${url.pathname}${url.search}`, 301);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const rec = await env.SITES.get(`site:${host}`, "json");
    if (!rec) return note(404, "Coming soon", `This site isn't set up yet. Websites by <a href="https://webburrito.com/">Web Burrito</a>.`);
    if (rec.state !== "live") {
      return note(503, rec.business || "Offline", `This website is offline right now. Websites by <a href="https://webburrito.com/">Web Burrito</a>.`);
    }
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      return note(404, "Page not found", `<a href="/">Go to the home page</a>`);
    }
    return new Response(request.method === "HEAD" ? null : rec.html, {
      headers: { ...HEADERS, "cache-control": "public, max-age=60" },
    });
  },
};
