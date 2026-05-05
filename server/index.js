process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ─── API KEYS (loaded from .env) ─────────────────────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const OPENAI_KEY     = process.env.OPENAI_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

if (!GOOGLE_API_KEY) console.warn('[WARN] GOOGLE_API_KEY missing in .env');
if (!OPENAI_KEY)     console.warn('[WARN] OPENAI_KEY missing in .env');

// ─── Helper: tolerant JSON extraction from any OpenAI response ─────────────
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

// ════════════════════════════════════════════════════════════════════════════
// GOOGLE PLACES PIPELINE
// ════════════════════════════════════════════════════════════════════════════

// ─── Google 1: find place via Text Search ────────────────────────────────────
app.post('/api/google/find-place', async (req, res) => {
  const { businessName, address } = req.body || {};
  if (!businessName) {
    return res.status(400).json({ error: 'businessName is required' });
  }

  const query = `${businessName}${address ? ' ' + address : ''}`.trim();
  const url =
    `https://maps.googleapis.com/maps/api/place/textsearch/json` +
    `?query=${encodeURIComponent(query)}` +
    `&fields=place_id,name,formatted_address,rating,user_ratings_total` +
    `&key=${GOOGLE_API_KEY}`;

  console.log(`\n[GOOGLE] Text search: "${query}"`);

  try {
    const r = await fetch(url);
    const data = await r.json();
    console.log(`[GOOGLE] Status: ${data.status} | Results: ${data.results?.length || 0}`);

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      const msg =
        data.status === 'ZERO_RESULTS'
          ? 'No place found for that name and address'
          : `Google Places error: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}`;
      return res.status(404).json({ error: msg });
    }

    const top = data.results[0];
    const place = {
      placeId: top.place_id,
      name: top.name,
      formattedAddress: top.formatted_address,
      rating: top.rating ?? null,
      totalReviews: top.user_ratings_total ?? 0,
    };
    console.log(`[GOOGLE] Top match: ${place.name} (${place.placeId}) — ★${place.rating} · ${place.totalReviews} reviews`);
    res.json(place);
  } catch (e) {
    console.error('[GOOGLE] Exception:', e.message);
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
      // Severity affects only the prefix.
      whatsappHook = isSevere
        ? `Repeated ${issuePhrase} complaints are pushing customers away.`
        : `${capitalize(issuePhrase)} complaints are pushing customers away.`;

      // Push: shortened, single issue
      pushBody = isSevere
        ? `Repeated ${issueWord} complaints losing customers? Pi Commerce wins them back. Try Now.`
        : `${capitalize(issueWord)} complaints losing customers? Pi Commerce wins them back. Try Now.`;

      // Banner: tighter, split into headline + subtext
      bannerText = isSevere
        ? `Repeated ${issueWord} complaints?`
        : `${capitalize(issueWord)} complaints losing customers?`;
      bannerSub = `Pi Commerce wins your customers back.`;

      bullet1 = 'Wins back lost customers';
      break;
    }

    case 'Decline': {
      whatsappHook = 'Customers who once loved you have stopped coming.';
      pushBody = 'Lost customers stopped coming? Pi Commerce wins them back. Try Now.';
      bannerText = 'Customers stopped coming?';
      bannerSub = 'Pi Commerce wins them back.';
      bullet1 = 'Wins back lost customers';
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
      whatsappHook = 'Customers come once and forget you.';
      pushBody = 'Customers visit once and forget you? Pi Commerce brings them back. Try Now.';
      bannerText = 'Customers visit once?';
      bannerSub = 'Pi Commerce brings them back.';
      bullet1 = 'Brings customers back for repeat visits';
      break;
    }

    case 'HiddenCeiling': {
      whatsappHook = ratingHigh
        ? `You're rated ${ratingStr} — but hundreds nearby don't know you.`
        : `Loved by customers — but hundreds nearby don't know you.`;
      pushBody = ratingHigh
        ? `Rated ${ratingStr} but Hundreds nearby don't know you? Pi Commerce gets new ones. Try Now.`
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
        ? `You're rated ${ratingStr} — but happy customers rarely return on their own.`
        : `Loved by customers — but few return on their own.`;
      pushBody = ratingHigh
        ? `Rated ${ratingStr} but happy customers rarely return? Pi Commerce brings them back. Try Now.`
        : `Happy customers rarely return? Pi Commerce brings them back. Try Now.`;
      bannerText = ratingHigh
        ? `Rated ${ratingStr}, but few return?`
        : `Happy customers rarely return?`;
      bannerSub = `Pi Commerce brings them back.`;
      bullet1 = 'Brings happy customers back';
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
// One LLM call → classification → templated copy across all 3 channels.
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

  console.log(`\n[OPENAI] Classifying ${merchantName} | ★${rating ?? '–'} · ${totalReviews} reviews | ${analyzable.length} review texts`);

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + OPENAI_KEY,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 600,
        temperature: 0.2, // Low — classification needs to be consistent across runs.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[OPENAI] Classification API error:', data?.error?.message || data);
      return res.status(r.status).json({ error: data?.error?.message || 'OpenAI request failed' });
    }

    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = safeExtractJson(raw);
    if (!parsed) {
      console.error('[OPENAI] Classification JSON parse failed. Raw:', raw.slice(0, 400));
      return res.status(500).json({ error: 'OpenAI returned malformed JSON' });
    }

    // Defensive sanitization in case mini hallucinates angle/issues.
    const classification = sanitizeClassification(parsed);

    // Deterministic copy from templates — no second LLM call.
    const copy = buildCopy({
      angle: classification.angle,
      issues: classification.issues,
      isSevere: classification.isSevere,
      rating,
      merchantName,
    });

    console.log(`[OPENAI] ${merchantName} → angle=${classification.angle} | issues=[${classification.issues.join(', ')}] | severe=${classification.isSevere}`);

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
    console.error('[OPENAI] Classification exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SERVER
// ════════════════════════════════════════════════════════════════════════════

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Pi Commerce Merchant Analyzer running → http://localhost:${PORT}\n`);
  console.log('Pipeline:');
  console.log('  POST /api/google/find-place    → Google Places Text Search');
  console.log('  POST /api/google/reviews       → Google Places Details (max 5, sort: most_relevant | newest)');
  console.log(`  POST /api/generate-copy        → ${OPENAI_MODEL}: classify + generate WhatsApp/Push/Banner\n`);
});
