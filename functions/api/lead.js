/**
 * Better Air NW - IAQ landing page lead handler
 * Cloudflare Pages Function. Route: POST /api/lead  (matches ENDPOINT in index.html)
 *
 * Receives the multipart form (firstName, email, concern, photo, cf-turnstile-response, source),
 * verifies the Cloudflare Turnstile token, stores the furnace photo, and creates a ServiceTitan
 * lead via the CRM web-form endpoint with a link to the photo in the lead summary.
 *
 * ServiceTitan note: the /leads/form endpoint is JSON (name, email, phoneNumber, address, summary)
 * and does NOT accept a file attachment, so the photo is stored separately and linked in the
 * summary. This matches the project README ("store the photo and put its link in the lead notes").
 *
 * Required Pages env vars / bindings (set on the betterairnw-iaq project, NOT committed to git):
 *   ST_CLIENT_ID, ST_CLIENT_SECRET, ST_APP_KEY, ST_TENANT_ID  - ServiceTitan API credentials
 *   ST_TOKEN_URL   (optional, default https://auth.servicetitan.io/connect/token)
 *   ST_API_BASE    (optional, default https://api.servicetitan.io)
 *   TURNSTILE_SECRET            - Cloudflare Turnstile secret key (created at go-live). If unset,
 *                                 the spam check is skipped so the form still works pre go-live.
 *   PHOTO_BUCKET   (R2 binding) - optional; where the furnace photo is stored.
 *   PHOTO_BASE_URL             - optional; public base URL for the R2 bucket (e.g. the r2.dev URL
 *                                 or a custom domain). Without it, the lead notes the photo key only.
 *
 * ServiceTitan blocks raw non-browser clients with Cloudflare error 1010, so every ST call sends a
 * browser User-Agent.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function verifyTurnstile(env, token, ip) {
  // No secret configured yet (pre go-live) -> do not block legitimate submissions.
  if (!env.TURNSTILE_SECRET) return true;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token || "" });
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const j = await r.json();
    return !!j.success;
  } catch (e) {
    return false;
  }
}

async function getServiceTitanToken(env) {
  const r = await fetch(env.ST_TOKEN_URL || "https://auth.servicetitan.io/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.ST_CLIENT_ID,
      client_secret: env.ST_CLIENT_SECRET
    })
  });
  if (!r.ok) throw new Error("ServiceTitan auth failed: HTTP " + r.status);
  const j = await r.json();
  if (!j.access_token) throw new Error("ServiceTitan auth returned no access_token");
  return j.access_token;
}

function concernLine(concern) {
  switch (concern) {
    case "allergies": return "Household: seasonal or environmental allergies";
    case "breathing-condition": return "Household: asthma or other breathing condition";
    case "none": return "Household: no allergies or asthma noted";
    default: return "";
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const form = await request.formData();
    const firstName = String(form.get("firstName") || "").trim();
    const email = String(form.get("email") || "").trim();
    const concern = String(form.get("concern") || "").trim();
    const source = String(form.get("source") || "iaq-landing").trim();
    const token = String(form.get("cf-turnstile-response") || "");
    const photo = form.get("photo");

    if (!firstName || !email) {
      return json({ ok: false, error: "Please include your name and email." }, 400);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "";
    const human = await verifyTurnstile(env, token, ip);
    if (!human) {
      return json({ ok: false, error: "Spam check failed. Please try again." }, 403);
    }

    // Store the furnace photo so its link can go in the lead. Degrades gracefully if no bucket yet.
    let photoUrl = "";
    if (photo && typeof photo.arrayBuffer === "function" && env.PHOTO_BUCKET) {
      const type = photo.type || "image/jpeg";
      const ext = type.indexOf("png") >= 0 ? "png" : (type.indexOf("webp") >= 0 ? "webp" : "jpg");
      const key = "leads/" + new Date().toISOString().slice(0, 10) + "/" + crypto.randomUUID() + "." + ext;
      await env.PHOTO_BUCKET.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: type } });
      const base = (env.PHOTO_BASE_URL || "").replace(/\/+$/, "");
      photoUrl = base ? base + "/" + key : key;
    }

    // Build the lead summary (the photo link lives here since the lead endpoint takes no file).
    const parts = [
      "New IAQ landing-page request (betterairnw.com).",
      concernLine(concern),
      photoUrl ? ("Furnace photo: " + photoUrl) : "Furnace photo submitted (not stored).",
      "Source: " + source
    ].filter(Boolean);
    const summary = parts.join("\n");

    // Create the ServiceTitan lead via the CRM web-form endpoint.
    const accessToken = await getServiceTitanToken(env);
    const url = (env.ST_API_BASE || "https://api.servicetitan.io") +
      "/crm/v2/tenant/" + env.ST_TENANT_ID + "/leads/form";
    const leadRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "ST-App-Key": env.ST_APP_KEY,
        "Content-Type": "application/json",
        "User-Agent": UA
      },
      body: JSON.stringify({ name: firstName, email: email, summary: summary })
    });

    if (!leadRes.ok) {
      const detail = (await leadRes.text()).slice(0, 300);
      return json({ ok: false, error: "Could not create the lead.", status: leadRes.status, detail }, 502);
    }
    const lead = await leadRes.json().catch(() => ({}));
    return json({ ok: true, leadId: lead.leadId || lead.id || null, photoStored: !!photoUrl });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 500);
  }
}

// A GET returns a harmless health note (no secrets), handy for a quick "is it wired" check.
export async function onRequestGet() {
  return json({ ok: true, service: "better-air-nw lead handler", method: "POST only" });
}
