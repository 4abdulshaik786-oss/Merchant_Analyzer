process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();

const { Pool } = require('pg');
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const fetch    = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── PostgreSQL (Neon) setup ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query(`
  CREATE TABLE IF NOT EXISTS merchants (
    merchant_id      TEXT PRIMARY KEY,
    name             TEXT,
    address          TEXT,
    latitude         REAL,
    longitude        REAL,
    cohort           TEXT,
    cohort_tagline   TEXT,
    analysis_summary TEXT,
    key_insights     TEXT,
    whatsapp_message TEXT,
    push_notification TEXT,
    banner_copy      TEXT,
    avg_rating       REAL,
    total_reviews    INTEGER,
    reviews_analyzed INTEGER,
    status           TEXT,
    error_message    TEXT,
    session_id       TEXT,
    processed_at     TEXT
  )
`).then(() => {
  console.log('[PostgreSQL] Database ready → Neon');
}).catch(err => {
  console.error('[PostgreSQL] Init error:', err.message);
  process.exit(1);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ─── API KEYS (loaded from .env) ─────────────────────────────────────────────
const GOOGLE_API_KEY     = process.env.GOOGLE_API_KEY;
const TRUFOUNDRY_TOKEN   = process.env.TRUFOUNDRY_TOKEN;
const TRUFOUNDRY_MODEL   = process.env.TRUFOUNDRY_MODEL || 'azure-paytm-east-us/gpt-4.1-mini';
const TRUFOUNDRY_BASE_URL = process.env.TRUFOUNDRY_BASE_URL || 'https://llm.tfy.pi.mypaytm.com/api/llm/api/inference/openai';

if (!GOOGLE_API_KEY)   console.warn('[WARN] GOOGLE_API_KEY missing in .env');
if (!TRUFOUNDRY_TOKEN) console.warn('[WARN] TRUFOUNDRY_TOKEN missing in .env');

// ─── Helper: tolerant JSON extraction from any LLM response ───────────────
function safeExtractJson(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/```json\s*|```\s*/gi, '').trim();
  try { return JSON.parse(s); } catch {}
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS — Pi Commerce framework (locked vocabulary + angle list)
// ════════════════════════════════════════════════════════════════════════════

// 17-term issue vocabulary. The LLM MUST pick from this list only.
// Keep in sync with the prompt below if you ever add/remove terms.
const ISSUE_VOCABULARY = [
  'cleanliness', 'hygiene', 'service', 'quality', 'freshness',
  'wait time', 'pricing', 'delivery', 'ambiance', 'variety',
  'availability', 'billing', 'seating', 'after sales',
  'payment issues', 'trust', 'safety',
];

// 7 angles from the Pi Commerce framework.
// (Severe is a flag inside Negative, not a separate angle.)
const VALID_ANGLES = [
  'Negative', 'Decline', 'LowTraffic', 'Neutral',
  'HiddenCeiling', 'CompetitorCatchUp', 'SilentChurn',
];

const VALID_CATEGORIES = [
  'Food & Beverages', 'Apparel & Footwear', 'Grocery & Kirana',
  'Clinic & Doctor', 'Electronics & Technology', 'Other',
];

// ─── Helper: normalize any Indian phone format to 0XXXXX XXXXX ────────────
function normalizeIndianPhone(raw) {
  if (!raw) return null;

  // strip everything except digits
  let digits = String(raw).replace(/[^\d]/g, '');

  // remove country code 91 if present (12 digits starting with 91)
  if (digits.startsWith('91') && digits.length === 12) {
    digits = digits.slice(2);
  }

  // remove leading 0 if present — we'll add it back cleanly
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // must be 10 digits at this point
  if (digits.length !== 10) {
    console.warn(`[PHONE] Unexpected digit count (${digits.length}) for raw: ${raw} — using as-is`);
    return String(raw).trim();
  }

  // format: 0XXXXX XXXXX — matches Google Maps India display format
  return `0${digits.slice(0, 5)} ${digits.slice(5)}`;
}

// ─── Helper: convert any Indian phone to +91XXXXXXXXXX (for findplacefromtext) ─
function toInternationalPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d]/g, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return `+91${digits}`;
}

// ════════════════════════════════════════════════════════════════════════════
// GOOGLE PLACES PIPELINE
// ════════════════════════════════════════════════════════════════════════════

// ─── Google 1: find place via findplacefromtext (phone) + textsearch (name) ──
app.post('/api/google/find-place', async (req, res) => {
  const { businessName, latitude, longitude } = req.body || {};
  const intlPhone = toInternationalPhone(req.body.phone);

  if (!intlPhone && !businessName) {
    return res.status(400).json({ error: 'phone or businessName is required' });
  }

  const hasCoords = latitude != null && longitude != null;

  // Uses findplacefromtext with inputtype=phonenumber — the correct API for phone lookups.
  // textsearch treats the query as freeform text and does NOT index phone numbers.
  const searchByPhone = async (radius = 2000) => {
    let url =
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
      `?input=${encodeURIComponent(intlPhone)}` +
      `&inputtype=phonenumber` +
      `&fields=place_id,name,formatted_address,rating,user_ratings_total`;
    if (hasCoords) url += `&locationbias=circle:${radius}@${latitude},${longitude}`;
    url += `&key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    return r.json();
  };

  const searchByName = async (query, radius = 500) => {
    let url =
      `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${encodeURIComponent(query)}` +
      `&key=${GOOGLE_API_KEY}`;
    if (hasCoords) url += `&location=${latitude},${longitude}&radius=${radius}`;
    const r = await fetch(url);
    return r.json();
  };

  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isSimilar = (a, b) => {
    if (!a || !b) return false;
    return normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a));
  };

  // findplacefromtext returns { candidates: [...] }
  const extractTopCandidate = (data) => {
    if (!data.candidates || data.candidates.length === 0) return null;
    const top = data.candidates[0];
    return {
      placeId:          top.place_id,
      name:             top.name,
      formattedAddress: top.formatted_address || '',
      rating:           top.rating ?? null,
      totalReviews:     top.user_ratings_total ?? 0,
    };
  };

  // textsearch returns { results: [...] }
  const extractTop = (data) => {
    if (!data.results || data.results.length === 0) return null;
    const top = data.results[0];
    return {
      placeId:          top.place_id,
      name:             top.name,
      formattedAddress: top.formatted_address,
      rating:           top.rating ?? null,
      totalReviews:     top.user_ratings_total ?? 0,
    };
  };

  try {
    // ── STEP 1: Phone via findplacefromtext (dedicated phone-number lookup) ──
    if (intlPhone) {
      console.log(`\n[MANUAL] Step 1: Phone lookup via findplacefromtext → ${intlPhone}${hasCoords ? ` @ ${latitude},${longitude}` : ''}`);
      const data = await searchByPhone(2000);
      console.log(`[MANUAL] findplacefromtext status=${data.status} candidates=${data.candidates?.length || 0}`);
      const result = extractTopCandidate(data);
      if (result) {
        console.log(`[MANUAL] Phone match: ${result.name}`);
        return res.json({ ...result, matchedBy: 'phone' });
      }
      console.log(`[MANUAL] Phone lookup returned no candidates`);
    }

    // ── STEP 2: Name fallback via textsearch ──────────────────────────────
    if (businessName) {
      console.log(`\n[MANUAL] Step 2: Name search → "${businessName}"${hasCoords ? ` @ ${latitude},${longitude}` : ''}`);
      let data = await searchByName(businessName, 500);
      if (!data.results || data.results.length === 0) {
        console.log(`[MANUAL] Name radius=500 empty, retrying 2000`);
        data = await searchByName(businessName, 2000);
      }
      const result = extractTop(data);
      if (result) {
        const confident = isSimilar(businessName, result.name);
        console.log(`[MANUAL] Name match: ${result.name} | similar=${confident}`);
        return res.json({ ...result, matchedBy: 'name', lowConfidence: !confident });
      }
      console.log(`[MANUAL] Name search returned no results`);
    }

    // ── STEP 3: Both failed ───────────────────────────────────────────────
    console.warn(`[MANUAL] All search attempts failed`);
    return res.status(404).json({ 
      error: 'No place found — phone lookup and name search both returned no results',
      matchedBy: null
    });

  } catch (e) {
    console.error('[MANUAL] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ─── Google 2: fetch reviews via Place Details ───────────────────────────────
app.post('/api/google/reviews', async (req, res) => {
  const { placeId, sortOrder, placeMetadata } = req.body || {};
  if (!placeId) return res.status(400).json({ error: 'placeId is required' });

  // Google Places Details supports two sort values: "most_relevant" (default)
  // and "newest". We fetch ONLY the chosen sort — no merging.
  const sortParam = sortOrder === 'newest' ? 'newest' : 'most_relevant';

  const url =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=reviews,name,rating,user_ratings_total` +
    `&reviews_sort=${sortParam}` +
    `&key=${GOOGLE_API_KEY}`;

  console.log(`\n[GOOGLE] Details fetch: ${placeId} | sort=${sortParam}`);

  try {
    const r = await fetch(url);
    const data = await r.json();
    console.log(`[GOOGLE] status=${data.status} count=${data.result?.reviews?.length || 0}`);

    if (data.status !== 'OK') {
      return res.status(404).json({
        error: `Google Places Details error: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}`,
      });
    }

    const rawReviews = data.result?.reviews || [];

    const reviews = rawReviews.map(rev => ({
      text: (rev.text || '').trim(),
      rating: rev.rating != null ? String(rev.rating) : '?',
      date: rev.relative_time_description || (rev.time ? new Date(rev.time * 1000).toISOString() : ''),
      authorName: rev.author_name || '',
    }));

    const withText = reviews.filter(r => r.text.length > 0).length;
    console.log(`[GOOGLE] Reviews returned: ${reviews.length} (${withText} with text)`);
    if (reviews.length < 5) {
      console.log(`[GOOGLE] Note: legacy Places Details API caps at 5 per place under any single sort.`);
    }

    const mergedMeta = placeMetadata || {
      name: data.result?.name,
      rating: data.result?.rating,
      totalReviews: data.result?.user_ratings_total,
    };

    res.json({
      reviews,
      placeMetadata: mergedMeta,
      source: 'google_places',
    });
  } catch (e) {
    console.error('[GOOGLE] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION PROMPT
// One LLM call. Returns structured JSON: summary + angle + issues + isSevere.
// Designed to work reliably on smaller models (gpt-4.1-mini, gpt-4o-mini).
// ════════════════════════════════════════════════════════════════════════════

const CLASSIFICATION_SYSTEM_PROMPT = `You analyze Google Maps reviews for a Paytm marketing tool called Pi Commerce. Your job is to read the merchant's reviews and return a STRUCTURED JSON object that downstream code uses to generate WhatsApp, Push, and Banner copy.

OUTPUT JSON SHAPE — return ONLY this object, no markdown, no code fences, no commentary:
{
  "summary": "2-3 sentence paragraph that mentions the rating and review count and describes the merchant's situation",
  "businessCategory": "Food & Beverages | Apparel & Footwear | Grocery & Kirana | Clinic & Doctor | Electronics & Technology | Other",
  "angle": "Negative | Decline | LowTraffic | Neutral | HiddenCeiling | CompetitorCatchUp | SilentChurn",
  "isSevere": true or false,
  "issues": ["issue1", "issue2"]
}

═══════════════════════════════════════════════════════════════
STEP 1 — DETECT ISSUES
═══════════════════════════════════════════════════════════════

Scan reviews for any of these 17 issue words. Match by meaning, not just exact wording.

ISSUE VOCABULARY (use these EXACT words in the issues array):
- cleanliness — dirty, dusty, smell, pests, unhygienic premises
- hygiene — food handling, sanitation, contamination concerns
- service — rude staff, inattentive staff, poor handling, slow response
- quality — food taste, fabric quality, product defects, medicine effectiveness, build issues
- freshness — stale food, expired groceries, old stock
- wait time — slow service, long queues, delayed appointments, billing delays
- pricing — expensive, hidden charges, unfair pricing, price hikes
- delivery — late delivery, packaging issues, wrong items
- ambiance — noisy, smoking, lighting, crowded vibe, music
- variety — limited range, missing options, narrow menu, few choices
- availability — out of stock, sizes unavailable, missing products
- billing — wrong bills, refund issues, payment errors, GST issues
- seating — cramped, no seating, no waiting area, poor layout
- after sales — warranty issues, return problems, follow-up gaps
- payment issues — UPI not working, only cash, card machine down
- trust — misleading claims, bait-and-switch, false promises
- safety — unsafe practices, security concerns, hazardous conditions

GUARDRAILS:
- "trust" only fires if reviews explicitly use words like: misleading, false, bait-and-switch, cheated, dishonest. Otherwise map to "quality" or "service".
- "safety" only fires if reviews explicitly use words like: unsafe, dangerous, risky, hazard. Otherwise map to "cleanliness" or "quality".

OUTPUT RULES FOR issues:
- 0 to 2 items only. Never more than 2.
- Words MUST come from the vocabulary above (case-sensitive, exact match).
- If multiple issues found, pick the 2 most prominent (mentioned most often or first).
- If no real issues are named in the reviews, return [].

═══════════════════════════════════════════════════════════════
STEP 2 — DETECT INTENSITY (for isSevere)
═══════════════════════════════════════════════════════════════

Set isSevere = true ONLY if reviews use intensity language such as:
"repeatedly", "constantly", "regularly", "many complaints", "multiple reviews mention",
"consistently complain", "common complaint", "every visit", "every order"

Otherwise isSevere = false.

═══════════════════════════════════════════════════════════════
STEP 3 — CLASSIFY ANGLE (follow this exact order, stop at the first match)
═══════════════════════════════════════════════════════════════

IF issues array is NOT empty:
  → angle = "Negative"
  → STOP

ELSE IF reviews mention decline language ("used to be", "not what it used to be", "going downhill", "lost its charm", "feels deserted", "not the same anymore"):
  → angle = "Decline"
  → STOP

ELSE IF reviews mention low-traffic language ("mostly empty", "rarely crowded", "no rush during peak", "thin lunch crowd", "store is quiet", "lacks footfall", "very few customers visible"):
  → angle = "LowTraffic"
  → STOP

ELSE IF reviews describe everything as average/okay/nothing special with no strong praise and no real issue:
  → angle = "Neutral"
  → STOP

ELSE IF reviews contain "hidden gem", "underrated", "wish more knew", "deserves more attention", OR (newly opened business AND fewer than 30 reviews):
  → angle = "HiddenCeiling"
  → STOP

ELSE IF reviews contain TIER 1 competitor signal (any of):
  - "X nearby is better than [merchant]"
  - "[other place] does it better"
  - customers switching between options
  - regulars going to a competitor instead
  - explicit comparison with a named alternative
  → angle = "CompetitorCatchUp"
  → STOP

ELSE IF reviews contain TIER 2 competitor signal (any of):
  - "stretch with many similar businesses"
  - "popular area with lots of options"
  - "crowded category"
AND reviews do NOT mention regulars, repeat customers, loyalty, "happy customers", or familiar faces:
  → angle = "CompetitorCatchUp"
  → STOP

ELSE (default for positive sentiment):
  → angle = "SilentChurn"

WHEN IN DOUBT → angle = "SilentChurn" (never leave it blank or invent a new value)

═══════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════

Example 1 — Negative
INPUT: Cold Rock Cafe. Rating 3.2, 145 reviews. Reviews mention inconsistent food, hygiene problems, and a smoking environment that bothers families.
OUTPUT:
{
  "summary": "Cold Rock Cafe is rated 3.2 across 145 reviews. Customers flag hygiene issues and a smoking-friendly environment that drives families away.",
  "businessCategory": "Food & Beverages",
  "angle": "Negative",
  "isSevere": false,
  "issues": ["cleanliness", "ambiance"]
}

Example 2 — Negative + Severe
INPUT: QuickFix Salon. Rating 3.6, 88 reviews. Customers repeatedly complain about hygiene and untrained staff. Multiple reviews mention the same issues every visit.
OUTPUT:
{
  "summary": "QuickFix Salon is rated 3.6 across 88 reviews. Customers repeatedly raise hygiene and service quality concerns across multiple visits.",
  "businessCategory": "Other",
  "angle": "Negative",
  "isSevere": true,
  "issues": ["hygiene", "service"]
}

Example 3 — Hidden Ceiling
INPUT: Bloom & Brew. Rating 4.6, 28 reviews. A tucked-away café with artisanal pastries. Multiple reviewers call it a hidden gem and wish more people knew about it.
OUTPUT:
{
  "summary": "Bloom & Brew is rated 4.6 across only 28 reviews. Customers explicitly call it a hidden gem and wish more people knew about it.",
  "businessCategory": "Food & Beverages",
  "angle": "HiddenCeiling",
  "isSevere": false,
  "issues": []
}

Example 4 — Silent Churn
INPUT: Roastery Coffee House. Rating 4.7, 412 reviews. Praised for specialty coffee and ambience. Some find it noisy or pricey but no major complaints.
OUTPUT:
{
  "summary": "Roastery Coffee House is rated 4.7 across 412 reviews. Praised for specialty coffee and ambience, with only minor mentions of noise and pricing.",
  "businessCategory": "Food & Beverages",
  "angle": "SilentChurn",
  "isSevere": false,
  "issues": []
}

Example 5 — Competitor Catch-Up
INPUT: Saffron Bistro. Rating 4.2, 230 reviews. Loyal weekday lunch crowd, but recent reviews mention a newer place down the street has better ambience and several regulars are going there instead.
OUTPUT:
{
  "summary": "Saffron Bistro is rated 4.2 across 230 reviews. While praised for weekday lunch quality, recent reviewers say a newer competitor down the street is winning over regulars.",
  "businessCategory": "Food & Beverages",
  "angle": "CompetitorCatchUp",
  "isSevere": false,
  "issues": []
}

Example 6 — Low Traffic
INPUT: Gemini Electronics. Rating 4.1, 56 reviews. Customers praise product knowledge but say the store is mostly empty during the day with very thin footfall.
OUTPUT:
{
  "summary": "Gemini Electronics is rated 4.1 across 56 reviews. Despite good product knowledge, customers note the store is mostly empty with very low footfall.",
  "businessCategory": "Electronics & Technology",
  "angle": "LowTraffic",
  "isSevere": false,
  "issues": []
}

Example 7 — Decline
INPUT: Mango Tree Restaurant. Rating 3.9, 320 reviews. Recent reviews say the place is not what it used to be and feels deserted compared to a few years ago.
OUTPUT:
{
  "summary": "Mango Tree Restaurant is rated 3.9 across 320 reviews. Recent reviewers describe it as not what it used to be, feeling deserted compared to its peak.",
  "businessCategory": "Food & Beverages",
  "angle": "Decline",
  "isSevere": false,
  "issues": []
}

Example 8 — Neutral
INPUT: Sunrise Tiffin Centre. Rating 3.7, 92 reviews. Food described as average, service okay, no standout dishes or major complaints. Most customers visit once and don't return often.
OUTPUT:
{
  "summary": "Sunrise Tiffin Centre is rated 3.7 across 92 reviews. Food and service are described as average with no standout features and no major complaints.",
  "businessCategory": "Food & Beverages",
  "angle": "Neutral",
  "isSevere": false,
  "issues": []
}

═══════════════════════════════════════════════════════════════
FINAL REMINDERS
═══════════════════════════════════════════════════════════════

- Output ONLY the JSON object. No markdown, no code fences, no explanation before or after.
- "issues" array MUST contain words ONLY from the 17-term vocabulary, spelled exactly.
- "angle" MUST be exactly one of the 7 strings listed.
- The summary MUST mention the rating and review count explicitly.
- When uncertain about the angle → use "SilentChurn".`;

// ════════════════════════════════════════════════════════════════════════════
// TEMPLATE FUNCTIONS — deterministic copy generation (no LLM)
// All templates follow the locked Pi Commerce framework.
// ════════════════════════════════════════════════════════════════════════════

function buildIssuePhrase(issues) {
  if (!issues || issues.length === 0) return null;
  if (issues.length === 1) return issues[0];
  return `${issues[0]} and ${issues[1]}`;
}

// Format rating for display (e.g. 4.5 → "4.5", 4 → "4.0")
function formatRating(rating) {
  if (rating == null) return null;
  const n = Number(rating);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/**
 * Generate WhatsApp / Push / Banner copy from the classification result.
 * Pure function. No LLM. No hardcoded category bias.
 */
function buildCopy({ angle, issues, isSevere, rating, merchantName }) {
  const issuePhrase = buildIssuePhrase(issues);
  const issueWord = (issues && issues[0]) || null;
  const ratingStr = formatRating(rating);
  const ratingHigh = ratingStr != null && Number(rating) >= 4.0;

  let whatsappHook;
  let pushBody;
  let bannerText;
  let bannerSub;
  let bullet1;

  switch (angle) {
    case 'Negative': {
      whatsappHook = isSevere
        ? `Repeated ${issuePhrase} complaints are pushing customers away.`
        : `${capitalize(issuePhrase)} complaints are pushing customers away.`;

      pushBody = isSevere
        ? `Repeated ${issueWord} complaints? Pi Commerce brings you more customers. Try Now.`
        : `${capitalize(issueWord)} complaints? Pi Commerce brings you more customers. Try Now.`;

      bannerText = isSevere
        ? `Repeated ${issueWord} complaints?`
        : `${capitalize(issueWord)} complaints?`;
      bannerSub = `Pi Commerce brings you more customers.`;

      bullet1 = 'Brings you more customers';
      break;
    }

    case 'Decline': {
      whatsappHook = 'Footfalls not what they used to be?';
      pushBody = 'Footfalls slowing down? Pi Commerce brings you more customers. Try Now.';
      bannerText = 'Footfalls slowing down?';
      bannerSub = 'Pi Commerce brings you more customers.';
      bullet1 = 'Brings you more customers';
      break;
    }

    case 'LowTraffic': {
      whatsappHook = 'Seeing low footfalls at your place?';
      pushBody = 'Low footfalls? Pi Commerce gets you more traffic. Try Now.';
      bannerText = 'Low footfalls?';
      bannerSub = 'Pi Commerce gets you more traffic.';
      bullet1 = 'Gets you more traffic';
      break;
    }

    case 'Neutral': {
      whatsappHook = 'Not enough customers walking in?';
      pushBody = 'Not enough customers? Pi Commerce brings you more. Try Now.';
      bannerText = 'Want more customers?';
      bannerSub = 'Pi Commerce brings you more customers.';
      bullet1 = 'Brings you more customers';
      break;
    }

    case 'HiddenCeiling': {
      whatsappHook = ratingHigh
        ? `You're rated ${ratingStr} — but hundreds nearby don't know you.`
        : `Loved by customers — but hundreds nearby don't know you.`;
      pushBody = ratingHigh
        ? `Rated ${ratingStr} but hundreds nearby don't know you? Pi Commerce gets new ones. Try Now.`
        : `Loved but unknown nearby? Pi Commerce gets new customers. Try Now.`;
      bannerText = ratingHigh
        ? `Rated ${ratingStr}, but unknown nearby?`
        : `Loved but unknown nearby?`;
      bannerSub = `Pi Commerce gets you new customers.`;
      bullet1 = 'Gets you hundreds of new customers';
      break;
    }

    case 'CompetitorCatchUp': {
      whatsappHook = ratingHigh
        ? `You're rated ${ratingStr} — but competition is catching up.`
        : `Loved by customers — but competition is catching up.`;
      pushBody = ratingHigh
        ? `Rated ${ratingStr} & Competition catching up? Pi Commerce gets new customers. Try Now.`
        : `Competition catching up? Pi Commerce gets new customers. Try Now.`;
      bannerText = ratingHigh
        ? `Rated ${ratingStr}, competition catching up?`
        : `Competition catching up?`;
      bannerSub = `Pi Commerce gets you new customers.`;
      bullet1 = 'Gets you new customers';
      break;
    }

    case 'SilentChurn':
    default: {
      whatsappHook = ratingHigh
        ? `You're rated ${ratingStr} — but are enough new customers finding you?`
        : `Loved by customers — but are enough new ones finding you?`;
      pushBody = ratingHigh
        ? `Rated ${ratingStr} but want more customers? Pi Commerce brings you more. Try Now.`
        : `Want more customers? Pi Commerce brings you more. Try Now.`;
      bannerText = ratingHigh
        ? `Rated ${ratingStr}, want more customers?`
        : `Want more customers?`;
      bannerSub = `Pi Commerce brings you more customers.`;
      bullet1 = 'Brings you more customers';
      break;
    }
  }

  const whatsapp =
    `Hi ${merchantName},\n\n` +
    `${whatsappHook}\n\n` +
    `Pi Commerce:\n` +
    `✅ ${bullet1}\n` +
    `✅ No agency or staff needed\n` +
    `✅ Works on its own\n\n` +
    `Launch Now`;

  return {
    whatsapp,
    push: pushBody,
    banner: {
      text: bannerText,
      sub: bannerSub,
    },
  };
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION & SANITIZATION — protects templates from malformed LLM output
// ════════════════════════════════════════════════════════════════════════════

function sanitizeClassification(parsed) {
  const safeAngle = VALID_ANGLES.includes(parsed?.angle) ? parsed.angle : 'SilentChurn';
  const safeCategory = VALID_CATEGORIES.includes(parsed?.businessCategory) ? parsed.businessCategory : 'Other';
  const safeIssues = Array.isArray(parsed?.issues)
    ? parsed.issues.filter(x => ISSUE_VOCABULARY.includes(x)).slice(0, 2)
    : [];

  let finalAngle = safeAngle;
  // Safety net: if angle says "Negative" but no valid issues, fall back to SilentChurn.
  // This prevents the templates from producing "null complaints are pushing customers away."
  if (finalAngle === 'Negative' && safeIssues.length === 0) {
    finalAngle = 'SilentChurn';
  }

  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary : '',
    businessCategory: safeCategory,
    angle: finalAngle,
    isSevere: parsed?.isSevere === true,
    issues: safeIssues,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN ENDPOINT — /api/generate-copy
// One LLM call (via TruFoundry) → classification → templated copy across all 3 channels.
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/generate-copy', async (req, res) => {
  const { reviews, placeMetadata } = req.body || {};

  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(400).json({ error: 'reviews array is required' });
  }
  if (!placeMetadata || !placeMetadata.name) {
    return res.status(400).json({ error: 'placeMetadata with name is required' });
  }

  const merchantName = placeMetadata.name;
  const rating = placeMetadata.rating != null ? Number(placeMetadata.rating) : null;
  const totalReviews = placeMetadata.totalReviews ?? reviews.length;

  // Only feed reviews that have actual text — rating-only rows add nothing.
  const analyzable = reviews.filter(r => (r.text || '').trim().length > 0);
  const reviewBlock = analyzable.slice(0, 5)
    .map((r, i) => `[${i + 1}] ★${r.rating} — ${r.text}`)
    .join('\n\n');

  const userMsg =
    `Merchant: ${merchantName}\n` +
    `Address: ${placeMetadata.formattedAddress || placeMetadata.address || ''}\n` +
    `Google rating: ${rating != null ? rating : 'unknown'}\n` +
    `Total reviews on Google: ${totalReviews}\n\n` +
    (reviewBlock
      ? `Reviews to analyze:\n\n${reviewBlock}`
      : `No review text available — base your output on the rating and review count alone.`);

  console.log(`\n[TRUFOUNDRY] Classifying ${merchantName} | ★${rating ?? '–'} · ${totalReviews} reviews | ${analyzable.length} review texts | model=${TRUFOUNDRY_MODEL}`);

  try {
    const r = await fetch(`${TRUFOUNDRY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + TRUFOUNDRY_TOKEN,
      },
      body: JSON.stringify({
        model: TRUFOUNDRY_MODEL,
        max_tokens: 600,
        temperature: 0.2, // Low — classification needs to be consistent across runs.
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[TRUFOUNDRY] Classification API error:', data?.error?.message || JSON.stringify(data));
      return res.status(r.status).json({ error: data?.error?.message || 'TruFoundry request failed' });
    }

    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = safeExtractJson(raw);
    if (!parsed) {
      console.error('[TRUFOUNDRY] Classification JSON parse failed. Raw:', raw.slice(0, 400));
      return res.status(500).json({ error: 'TruFoundry returned malformed JSON' });
    }

    // Defensive sanitization in case model hallucinates angle/issues.
    const classification = sanitizeClassification(parsed);

    // Deterministic copy from templates — no second LLM call.
    const copy = buildCopy({
      angle: classification.angle,
      issues: classification.issues,
      isSevere: classification.isSevere,
      rating,
      merchantName,
    });

    console.log(`[TRUFOUNDRY] ${merchantName} → angle=${classification.angle} | issues=[${classification.issues.join(', ')}] | severe=${classification.isSevere}`);

    res.json({
      classification,
      copy,
      placeMetadata: {
        name: merchantName,
        rating,
        totalReviews,
        formattedAddress: placeMetadata.formattedAddress || placeMetadata.address || '',
      },
    });
  } catch (e) {
    console.error('[TRUFOUNDRY] Classification exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BATCH ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

const { parse } = require('csv-parse/sync');



// ── Column-name aliases → canonical field name ────────────────────────────
function normalizeColumns(record) {
  const find = (...keys) => {
    for (const k of keys) {
      const hit = Object.keys(record).find(r => r.toLowerCase() === k.toLowerCase());
      if (hit !== undefined) return record[hit];
    }
    return undefined;
  };
  return {
    merchant_id: find('merchant_id', 'merchantid', 'merchant id', 'id'),
    name:        find('name', 'business_name', 'businessname', 'business name'),
    phone:       find('phone', 'mobile', 'phone_number', 'contact', 'mobile_number'), // ← NEW
    latitude:    find('latitude', 'lat'),
    longitude:   find('longitude', 'lng', 'lon', 'long'),
  };
}

// GET /api/batch/preview
// Reads MerchantData.csv from project root and returns normalized rows.
app.get('/api/batch/preview', (req, res) => {
  const csvPath = path.join(process.cwd(), 'MerchantData.csv');
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'MerchantData.csv not found in project root' });
  }

  try {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

    // Validate required columns exist on at least the first row
    if (records.length > 0) {
      const norm = normalizeColumns(records[0]);
     const REQUIRED_CSV_COLS = ['merchant_id', 'phone', 'latitude', 'longitude'];
const missing = REQUIRED_CSV_COLS
  .filter(col => norm[col] === undefined);
      if (missing.length) {
        return res.status(400).json({
          error: `Missing required column: ${missing.join(', ')} in MerchantData.csv`,
        });
      }
    }

    const merchants = records
      .map(normalizeColumns)
      .filter(m => m.merchant_id !== undefined && m.phone !== undefined);

    console.log(`[BATCH] Loaded ${merchants.length} merchants from MerchantData.csv`);
    res.json({ merchants, total: merchants.length });
  } catch (e) {
    console.error('[BATCH] CSV parse error:', e.message);
    res.status(500).json({ error: `CSV parse error: ${e.message}` });
  }
});

// POST /api/batch/find-place-by-coordinates
// Finds a place using phone (findplacefromtext) then name (textsearch) as fallback.
app.post('/api/batch/find-place-by-coordinates', async (req, res) => {
  const { name, latitude, longitude, merchant_id } = req.body || {};

  // Fix: use normalizeIndianPhone (not normalizeColumns) to parse the phone string
  const intlPhone = toInternationalPhone(req.body.phone);

  if (!intlPhone || latitude == null || longitude == null) {
    return res.status(400).json({ 
      error: 'phone (valid 10-digit Indian number), latitude, and longitude are required' 
    });
  }

  const location = `${latitude},${longitude}`;

  // findplacefromtext with inputtype=phonenumber — correct API for phone lookups
  const searchByPhone = async (radius = 2000) => {
    const url =
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
      `?input=${encodeURIComponent(intlPhone)}` +
      `&inputtype=phonenumber` +
      `&fields=place_id,name,formatted_address,rating,user_ratings_total` +
      `&locationbias=circle:${radius}@${location}` +
      `&key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    return r.json();
  };

  const searchByName = async (query, radius) => {
    const url =
      `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${encodeURIComponent(query)}` +
      `&location=${location}` +
      `&radius=${radius}` +
      `&key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    return r.json();
  };

  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isSimilar = (a, b) => {
    if (!a || !b) return false;
    return normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a));
  };

  // findplacefromtext returns { candidates: [...] }
  const extractTopCandidate = (data) => {
    if (!data.candidates || data.candidates.length === 0) return null;
    const top = data.candidates[0];
    return {
      placeId:          top.place_id,
      name:             top.name,
      formattedAddress: top.formatted_address || '',
      rating:           top.rating ?? null,
      totalReviews:     top.user_ratings_total ?? 0,
    };
  };

  // textsearch returns { results: [...] }
  const extractTop = (data) => {
    if (!data.results || data.results.length === 0) return null;
    const top = data.results[0];
    return {
      placeId:          top.place_id,
      name:             top.name,
      formattedAddress: top.formatted_address || '',
      rating:           top.rating ?? null,
      totalReviews:     top.user_ratings_total ?? 0,
    };
  };

  try {
    // ── STEP 1: Phone via findplacefromtext (dedicated phone-number lookup) ─
    console.log(`\n[BATCH ${merchant_id}] Step 1: Phone lookup via findplacefromtext → ${intlPhone}`);
    const phoneData = await searchByPhone(2000);
    console.log(`[BATCH ${merchant_id}] findplacefromtext status=${phoneData.status} candidates=${phoneData.candidates?.length || 0}`);
    const phoneResult = extractTopCandidate(phoneData);
    if (phoneResult) {
      console.log(`[BATCH ${merchant_id}] Phone match: ${phoneResult.name} | matchedBy=phone`);
      return res.json({ ...phoneResult, matchedBy: 'phone' });
    }
    console.log(`[BATCH ${merchant_id}] Phone lookup returned no candidates`);

    // ── STEP 2: Name + coordinates fallback (only if name provided) ────────
    if (name) {
      console.log(`[BATCH ${merchant_id}] Step 2: Name search → ${name}`);
      let data = await searchByName(name, 500);
      if (!data.results || data.results.length === 0) {
        console.log(`[BATCH ${merchant_id}] Name radius=500 empty, retrying 2000`);
        data = await searchByName(name, 2000);
      }

      const result = extractTop(data);
      if (result) {
        const confident = isSimilar(name, result.name);
        console.log(`[BATCH ${merchant_id}] Name match: ${result.name} | similar=${confident}`);
        return res.json({ 
          ...result, 
          matchedBy: 'name',
          lowConfidence: !confident
        });
      }
    }

    // ── STEP 3: Both failed ───────────────────────────────────────────────
    console.warn(`[BATCH ${merchant_id}] Phone lookup and name search both failed`);
    return res.status(404).json({ 
      error: 'Place not found — phone lookup and name search both returned no results',
      matchedBy: null
    });

  } catch (e) {
    console.error(`[BATCH ${merchant_id}] find-place error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});
// ── Helper: split push notification into title + body ─────────────────────
// Tries "? " boundary first (most hooks end with "?"), then ". ".
function splitPush(str) {
  if (!str) return { title: '', body: '' };
  const qIdx = str.indexOf('?');
  if (qIdx !== -1 && qIdx < str.length - 1) {
    return { title: str.slice(0, qIdx + 1).trim(), body: str.slice(qIdx + 1).trim() };
  }
  const m = str.match(/^(.+?\.)\s+(.+)$/s);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  return { title: str.trim(), body: '' };
}

// ── Helper: split banner copy into headline + subtext ─────────────────────
// Banner is stored as "headline\nsubtext"; falls back to whole string.
function splitBanner(str) {
  if (!str) return { headline: '', subtext: '' };
  const nl = str.indexOf('\n');
  if (nl !== -1) {
    return { headline: str.slice(0, nl).trim(), subtext: str.slice(nl + 1).trim() };
  }
  return { headline: str.trim(), subtext: '' };
}

function splitWhatsapp(str) {
  if (!str) {
    return {
      h1: '',
      h2: '',
      h3: '',
      s1: '',
      s2: '',
      s3: '',
      h4: '',
    };
  }

  const lines = str
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  return {
    h1: lines[0] || '',
    h2: lines[1] || '',
    h3: lines[2] || '',
    s1: lines[3] || '',
    s2: lines[4] || '',
    s3: lines[5] || '',
    h4: lines[6] || '',
  };
}

// ── Helper: transform flat body into the CleverTap-ready nested structure ──
function structureMerchant(body, savedAt) {
  const push   = splitPush(body.push_notification || '');
  const banner = splitBanner(body.banner_copy || '');
  return {
    merchant_id: body.merchant_id,
    name:        body.name,

    profile: {
      address:  body.address || '',
      location: {
        latitude:  String(body.latitude  ?? ''),
        longitude: String(body.longitude ?? ''),
      },
    },

    analysis: {
      cohort:           body.cohort           || '',
      cohort_tagline:   body.cohort_tagline   || '',
      avg_rating:       body.avg_rating       ?? null,
      total_reviews:    body.total_reviews    ?? null,
      reviews_analyzed: body.reviews_analyzed ?? null,
      summary:          body.analysis_summary || '',
      key_insights:     Array.isArray(body.key_insights) ? body.key_insights : [],
    },

   content: {
  whatsapp: splitWhatsapp(body.whatsapp_message || ''),
  push:     { title: push.title, body: push.body },
  banner:   { headline: banner.headline, subtext: banner.subtext },
},

    meta: {
      status:        body.status        || '',
      error_message: body.error_message || null,
      processed_at:  body.processed_at  || new Date().toISOString(),
      saved_at:      savedAt            || new Date().toISOString(),
    },
  };
}

// POST /api/batch/save-result
app.post('/api/batch/save-result', async (req, res) => {
  try {
    const data = req.body || {};
    const { whatsapp_image_base64, push_image_base64, banner_image_base64, ...textData } = data;

    await pool.query(`
      INSERT INTO merchants (
        merchant_id, name, address, latitude, longitude,
        cohort, cohort_tagline, analysis_summary,
        key_insights, whatsapp_message, push_notification,
        banner_copy, avg_rating, total_reviews,
        reviews_analyzed, status, error_message,
        session_id, processed_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17,
        $18, $19
      )
      ON CONFLICT(merchant_id) DO UPDATE SET
        name=EXCLUDED.name,
        address=EXCLUDED.address,
        latitude=EXCLUDED.latitude,
        longitude=EXCLUDED.longitude,
        cohort=EXCLUDED.cohort,
        cohort_tagline=EXCLUDED.cohort_tagline,
        analysis_summary=EXCLUDED.analysis_summary,
        key_insights=EXCLUDED.key_insights,
        whatsapp_message=EXCLUDED.whatsapp_message,
        push_notification=EXCLUDED.push_notification,
        banner_copy=EXCLUDED.banner_copy,
        avg_rating=EXCLUDED.avg_rating,
        total_reviews=EXCLUDED.total_reviews,
        reviews_analyzed=EXCLUDED.reviews_analyzed,
        status=EXCLUDED.status,
        error_message=EXCLUDED.error_message,
        session_id=EXCLUDED.session_id,
        processed_at=EXCLUDED.processed_at
    `, [
      String(textData.merchant_id),
      textData.name             || null,
      textData.address          || null,
      textData.latitude         ?? null,
      textData.longitude        ?? null,
      textData.cohort           || null,
      textData.cohort_tagline   || null,
      textData.analysis_summary || null,
      JSON.stringify(textData.key_insights || []),
      textData.whatsapp_message  || null,
      textData.push_notification || null,
      textData.banner_copy       || null,
      textData.avg_rating        ?? null,
      textData.total_reviews     ?? null,
      textData.reviews_analyzed  ?? null,
      textData.status            || 'pending',
      textData.error_message     || null,
      String(textData.session_id || ''),
      new Date().toISOString(),
    ]);

    const countResult = await pool.query('SELECT COUNT(*) as count FROM merchants');
    const total = parseInt(countResult.rows[0].count, 10);
    console.log(`[BATCH ${textData.merchant_id}] Saved to PostgreSQL | Total: ${total}`);
    res.json({ saved: true, total_saved: total });
  } catch (err) {
    console.error('[PostgreSQL] Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/batch/export-data?sessionId=xxx
app.get('/api/batch/export-data', async (req, res) => {
  try {
    const { sessionId } = req.query;
    const { rows } = await pool.query('SELECT * FROM merchants WHERE session_id = $1', [String(sessionId)]);
    const results = rows.map(r => ({ ...r, key_insights: JSON.parse(r.key_insights || '[]') }));

    res.json({
      results,
      total: results.length,
      successful: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CLEVERTAP LINKED CONTENT API
// ════════════════════════════════════════════════════════════════════════════

async function findMerchant(merchant_id) {
  try {
    const { rows } = await pool.query('SELECT * FROM merchants WHERE merchant_id = $1', [String(merchant_id)]);
    if (rows.length === 0) return null;
    const m = rows[0];
    return { ...m, key_insights: JSON.parse(m.key_insights || '[]') };
  } catch (err) {
    console.error('[PostgreSQL] findMerchant error:', err.message);
    return null;
  }
}

// GET /api/v1/merchants/:merchant_id
// Returns the fully-structured merchant object for CleverTap Linked Content.
app.get('/api/v1/merchants/:merchant_id', async (req, res) => {
  const { merchant_id } = req.params;
  console.log(`[CLEVERTAP] Fetching data for merchant_id: ${merchant_id}`);

  const m = await findMerchant(merchant_id);
  if (!m) return res.status(404).json({ error: 'Merchant not found' });

  res.json(structureMerchant(m, m.processed_at));
});

// GET /api/clevertap/whatsapp?merchant_id=xxx
app.get('/api/clevertap/whatsapp', async (req, res) => {
  const { merchant_id } = req.query;
  if (!merchant_id) return res.status(400).json({ error: 'merchant_id required' });
  const m = await findMerchant(merchant_id);
  if (!m) return res.status(404).json({ error: `Merchant ${merchant_id} not found` });
  res.json({
    merchant_id:       m.merchant_id,
    business_name:     m.name,
    pi_commerce_angle: m.cohort,
    message:           m.whatsapp_message
  });
});

// GET /api/clevertap/push?merchant_id=xxx
app.get('/api/clevertap/push', async (req, res) => {
  const { merchant_id } = req.query;
  if (!merchant_id) return res.status(400).json({ error: 'merchant_id required' });
  const m = await findMerchant(merchant_id);
  if (!m) return res.status(404).json({ error: `Merchant ${merchant_id} not found` });
  res.json({
    merchant_id:       m.merchant_id,
    business_name:     m.name,
    pi_commerce_angle: m.cohort,
    title:             m.push_notification?.split('.')[0] || m.push_notification,
    body:              m.push_notification
  });
});

// GET /api/clevertap/banner?merchant_id=xxx
app.get('/api/clevertap/banner', async (req, res) => {
  const { merchant_id } = req.query;
  if (!merchant_id) return res.status(400).json({ error: 'merchant_id required' });
  const m = await findMerchant(merchant_id);
  if (!m) return res.status(404).json({ error: `Merchant ${merchant_id} not found` });
  res.json({
    merchant_id:       m.merchant_id,
    business_name:     m.name,
    pi_commerce_angle: m.cohort,
    headline:          m.banner_copy?.split('.')[0] || m.banner_copy,
    subtext:           m.banner_copy
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVER
// ════════════════════════════════════════════════════════════════════════════

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Pi Commerce Merchant Analyzer running → http://localhost:${PORT}\n`);
  console.log('Pipeline:');
  console.log('  POST /api/google/find-place          → Google Places Text Search');
  console.log('  POST /api/google/reviews             → Google Places Details (max 5)');
  console.log(`  POST /api/generate-copy              → TruFoundry (${TRUFOUNDRY_MODEL}): classify + generate copy`);
  console.log('  GET  /api/v1/merchants/:merchant_id  → CleverTap Linked Content');
  console.log('  GET  /api/clevertap/whatsapp         → WhatsApp message');
  console.log('  GET  /api/clevertap/push             → Push notification');
  console.log('  GET  /api/clevertap/banner           → Banner copy\n');
});