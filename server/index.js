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
// GOOGLE PLACES PIPELINE
// ════════════════════════════════════════════════════════════════════════════

// ─── Google 1: find place via Text Search ────────────────────────────────────
app.post('/api/google/find-place', async (req, res) => {
  const { businessName, address } = req.body || {};
  if (!businessName) {
    return res.status(400).json({ error: 'businessName is required' });
  }

  // Frontend now sends a single combined string in `businessName`
  // (e.g. "Bon Amigos Cafe, Sector 76, Noida"). Address remains optional
  // for backwards compatibility — both shapes flow into the same query.
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

  // Google Places legacy Details endpoint returns up to 5 reviews and supports
  // two sort values: "most_relevant" (default) and "newest". We fetch ONLY the
  // sort the user chose — no merging across sorts.
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

    // Return EVERY review Google gives us under the selected sort — no time
    // filter, no empty-text filter. Rating-only reviews are kept too so the
    // count is honest. Each LLM endpoint filters internally for text content
    // when its prompt requires it, so rating-only rows never pollute analysis.
    const reviews = rawReviews.map(rev => ({
      text: (rev.text || '').trim(),
      rating: rev.rating != null ? String(rev.rating) : '?',
      date: rev.relative_time_description || (rev.time ? new Date(rev.time * 1000).toISOString() : ''),
      authorName: rev.author_name || '',
    }));

    const withText = reviews.filter(r => r.text.length > 0).length;
    console.log(`[GOOGLE] Reviews returned by API: ${reviews.length} (${withText} with text content)`);
    if (reviews.length < 5) {
      console.log(`[GOOGLE] Note: Google returned ${reviews.length} reviews under "${sortParam}" — the legacy Places Details API caps at 5 per place, and Google may surface fewer under a given sort.`);
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
// SHARED — OpenAI cohort analysis
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/analyze', async (req, res) => {
  const { reviews, placeMetadata } = req.body || {};
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(400).json({ error: 'reviews array is required' });
  }

  // Only feed reviews that have written text to the LLM — rating-only rows
  // contribute no language signal and would just be noise in the prompt.
  const analyzable = reviews.filter(r => (r.text || '').trim().length > 0);
  const sample = analyzable.slice(0, 300);
  const reviewBlock = sample
    .map((r, i) => `[${i + 1}] ★${r.rating} — ${r.text}`)
    .join('\n\n');

  console.log(`\n[OPENAI] Analyzing ${sample.length} reviews with text (of ${reviews.length} total)...`);
  if (placeMetadata) {
    console.log(`[OPENAI] Merchant: ${placeMetadata.name} | ★${placeMetadata.rating} · ${placeMetadata.totalReviews} reviews`);
  }

  const systemPrompt = `You are an expert merchant analyst for a commerce platform. Analyze the provided Google Maps reviews and classify this merchant into the most relevant customer cohorts from the Pi Commerce framework below.

THE 6 COHORTS:

1. acquisition_gap — "Nobody knows we exist"
   Signals: Low review volume despite being open long, customers found by accident,
   "hidden gem", "wish more people knew", very few reviews total

2. retention_winback — "Our regulars stopped coming"  
   Signals: Former regulars stopped visiting, quality or service decline mentioned,
   "used to love this place", "haven't been back in months", lapsed loyal customers

3. frequency — "They like us but only visit twice a year"
   Signals: Customers enjoy it but visit rarely, "great for special occasions",
   "go once a year for birthdays", "treat-yourself place", positive but infrequent

4. off_peak_imbalance — "Crushed at lunch, dead at 4 PM"
   Signals: Peak-hour crowding and long queues, empty during off-peak, timing
   complaints, "don't go between 1-2 PM", rush hour issues

5. competitive_loss — "Customers are going to the shop next door"
   Signals: Explicit competitor mentions, "X across the street is better",
   "since Y opened this place declined", switching behavior

6. personalization_gap — "Our marketing is irrelevant to them"
   Signals: Irrelevant promotions, "offers I don't care about",
   "they don't know me even after 20 visits", blanket campaigns, preference mismatch

Return ONLY this raw JSON object — no markdown, no code fences, no explanation:
{
  "primaryCohort": "cohort_id",
  "allCohorts": [
    {
      "id": "cohort_id",
      "score": 0-100,
      "evidence": ["exact quote or close paraphrase from a review", "another quote"]
    }
  ],
  "summary": "2-3 sentence plain English summary of this merchant's main customer problem",
  "totalReviewsAnalyzed": number,
  "avgRating": number,
  "keyInsights": ["specific actionable insight 1", "insight 2", "insight 3"]
}

Rules:
- Only include cohorts with score > 10
- Sort allCohorts by score descending  
- Evidence must be actual quotes or paraphrases from the reviews provided
- avgRating calculated from star ratings in the reviews
- keyInsights must be specific and actionable, not generic`;

  const userMsg =
    (placeMetadata
      ? `Merchant: ${placeMetadata.name}\nAddress: ${placeMetadata.address || placeMetadata.formattedAddress || ''}\nGoogle rating: ${placeMetadata.rating} (${placeMetadata.totalReviews} total reviews)\n\n`
      : '') +
    `Analyze these ${sample.length} reviews:\n\n${reviewBlock}`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + OPENAI_KEY,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 2000,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[OPENAI] API error:', data?.error?.message || data);
      return res.status(r.status).json({ error: data?.error?.message || 'OpenAI request failed' });
    }

    const raw = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[OPENAI] JSON parse failed. Raw:', raw.slice(0, 400));
      return res.status(500).json({ error: 'OpenAI returned malformed JSON' });
    }

    console.log(`[OPENAI] Primary cohort: ${parsed.primaryCohort} | cohorts: ${parsed.allCohorts?.length || 0}`);
    res.json(parsed);
  } catch (e) {
    console.error('[OPENAI] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SHARED — Merchant message generator
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/generate-message', async (req, res) => {
  const {
    primaryCohort,
    cohortTagline,
    merchantName,
    avgRating,
    totalReviews,
    summary,
    keyInsights = [],
  } = req.body || {};

  if (!primaryCohort || !merchantName) {
    return res.status(400).json({ error: 'primaryCohort and merchantName are required' });
  }

  console.log(`\n[OPENAI] Generating merchant message for ${merchantName} | cohort: ${primaryCohort}`);

  const systemPrompt = `You are a Paytm relationship manager writing a SHORT punchy WhatsApp message to a merchant — emoji-bullet style, NOT paragraphs.

Match this EXACT structure and length (around 40–55 words total, never more than 60):

Namaste {MerchantName}, 👋

🚀 Meet your AI growth partner — Pi Commerce on Paytm

{ONE-LINE HOOK tied to the merchant's specific problem — max 12 words}

Get more for your business with AI:
{emoji} {benefit 1 — 4 to 6 words}
{emoji} {benefit 2 — 4 to 6 words}
{emoji} {benefit 3 — 4 to 6 words}

Everything automatic ✨

👉 Notify Me

— Team Paytm

Pick the 3 benefit lines from the relevant Pi Commerce play for the detected cohort. Use these mappings (keep each benefit short — 4 to 6 words, like the example):

acquisition_gap → "Nobody knows we exist"
  📢 Hyperlocal banners to nearby Paytm users
  🎯 Geo-targeted WhatsApp offers
  👥 New-customer acquisition deals

retention_winback → "Our regulars stopped coming"
  💬 Win-back WhatsApp & SMS to lapsed customers
  🔁 Auto-detect 30/60-day inactive shoppers
  🎁 Personalised comeback offers

frequency → "They like us but only visit twice a year"
  ⭐ Loyalty nudges and milestone rewards
  🔂 "5th visit free" mechanics
  📲 Repeat-purchase reminders

off_peak_imbalance → "Crushed at lunch, dead at 4 PM"
  ⏰ Peak Hour Insights dashboard
  🌙 Quiet-stretch promo offers
  📉 Smart off-peak nudges

competitive_loss → "Customers are going to the shop next door"
  🛡️ Defensive offers before customers switch
  📞 AI voice alert on competitor threats
  💌 Auto win-back to lapsed regulars

personalization_gap → "Our marketing is irrelevant to them"
  🧠 Paytm Recommendation Engine
  🥗 Customer-specific category offers
  🎂 Birthday & milestone-aware deals

The ONE-LINE HOOK must reference the merchant's actual problem in plain words (e.g. for acquisition_gap: "Reviews say you're a hidden gem — let's fix that." or for retention_winback: "Get your old regulars walking back in.").

Rules:
- Keep total output 40–55 words
- Use emojis on every bullet
- NO long paragraphs
- NO sales pitch
- Friendly and direct
- Use the merchant's actual name in the greeting (never "[Name]" — substitute it)
- Output ONLY the message text. No labels, no quotes, no code fences, no extra commentary.`;

  const userMsg =
    `Merchant name: ${merchantName}\n` +
    `Primary cohort: ${primaryCohort}\n` +
    `Cohort tagline: ${cohortTagline || ''}\n` +
    `Avg rating: ${avgRating ?? '–'} stars\n` +
    `Total reviews on Google: ${totalReviews ?? '–'}\n` +
    `Analysis summary: ${summary || ''}\n` +
    `Key insights from reviews: ${(keyInsights || []).join(' | ')}`;

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
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[OPENAI] Message API error:', data?.error?.message || data);
      return res.status(r.status).json({ error: data?.error?.message || 'OpenAI request failed' });
    }

    const message = (data.choices?.[0]?.message?.content || '').trim();
    if (!message) return res.status(500).json({ error: 'OpenAI returned empty message' });

    console.log(`[OPENAI] Message generated (${message.split(/\s+/).length} words)`);
    res.json({ message });
  } catch (e) {
    console.error('[OPENAI] Message exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Pain Point Insights — extract concrete pains from the actual reviews
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/pain-points', async (req, res) => {
  const { reviews, placeMetadata } = req.body || {};
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(400).json({ error: 'reviews array is required' });
  }

  // Pain points need actual customer language — drop rating-only rows.
  const analyzable = reviews.filter(r => (r.text || '').trim().length > 0);
  const sample = analyzable.slice(0, 50);
  const reviewBlock = sample
    .map((r, i) => {
      const author = r.authorName || 'Customer';
      const date = r.date || '';
      return `[${i + 1}] (${author}${date ? ' · ' + date : ''}) ★${r.rating} — ${r.text}`;
    })
    .join('\n\n');

  console.log(`\n[OPENAI] Extracting pain points from ${sample.length} reviews with text (of ${reviews.length} total) for ${placeMetadata?.name || 'merchant'}...`);

  const systemPrompt = `You are a customer feedback analyst. Read the Google Maps reviews provided and surface 2 to 5 distinct customer-voice insights about this merchant.

For each item return:
- pain: a one-line plain-language observation (e.g. "Customers complaining about smoking near the entrance", "Reviews are sparse — only short positive blurbs", "No recent reviews — limited customer engagement signal")
- quotes: 0 to 2 verbatim quotes from the reviews that support the observation. Each quote object has { text, author, date }. Use the reviewer's first name if shown; date should be a short month/year if shown ("May 2025"), else empty string. Quotes MUST be actual text from the reviews provided — NEVER invent words that don't appear in the input.
- frequency: integer count of how many reviews in the input support this observation (count carefully)

Return ONLY this raw JSON — no markdown, no code fences:
{
  "painPoints": [
    {
      "pain": "one-line observation",
      "quotes": [{ "text": "verbatim quote from input", "author": "First name", "date": "Month YYYY" }],
      "frequency": 0
    }
  ]
}

PRIORITY ORDER for what to surface:

A. CONCRETE OPERATIONAL PAINS (preferred when present): smoking, slow service, food quality, parking, queue, staff rudeness, hygiene, pricing, ambience. Use literal customer language. Include 1-2 verbatim quotes per pain.

B. MARKETING / VISIBILITY PAINS (when operational pains aren't present): low review count vs business age, very short reviews suggesting low engagement, sparse recent activity, "found by accident" language, lack of repeat-visit language. Quotes optional.

C. POSITIVE-PATTERN INSIGHTS (when reviews are overwhelmingly short and positive — e.g. "good", "Gd", "Good vibe"): describe the PATTERN itself as a marketing-actionable observation. Examples:
   - "Customers leaving very short positive reviews — limited word-of-mouth richness"
   - "Few recent reviews despite high overall rating — visibility gap"
   - "Reviews mention atmosphere/people but not specific products or experiences — story not landing"
   These are observations about the review behaviour, NOT invented complaints. Quotes can be omitted or use the actual short snippets ("Gd", "Good vibe").

GLOBAL RULES:
- ALWAYS return at least 2 items in painPoints. Empty array is unacceptable.
- NEVER fabricate quotes. If a customer didn't say "hidden gem", don't put "hidden gem" in a quote.
- NEVER invent operational issues that aren't actually mentioned in the reviews.
- Sort painPoints by frequency descending.
- Quotes can be slightly trimmed for length but every word must appear in the source review.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 1500,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content:
              `Merchant: ${placeMetadata?.name || ''}\n` +
              `Address: ${placeMetadata?.formattedAddress || placeMetadata?.address || ''}\n\n` +
              `Reviews:\n\n${reviewBlock}`,
          },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[OPENAI] Pain-points API error:', data?.error?.message || data);
      return res.status(r.status).json({ error: data?.error?.message || 'OpenAI request failed' });
    }

    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = safeExtractJson(raw);
    if (!parsed) {
      console.error('[OPENAI] Pain-points JSON parse failed. Raw:', raw.slice(0, 400));
      return res.status(500).json({ error: 'OpenAI returned malformed JSON' });
    }

    const painPoints = Array.isArray(parsed.painPoints) ? parsed.painPoints : [];
    console.log(`[OPENAI] Extracted ${painPoints.length} pain points`);
    res.json({ painPoints });
  } catch (e) {
    console.error('[OPENAI] Pain-points exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Channel Creative Preview — banner / push / whatsapp copy from pain points
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/channel-copy', async (req, res) => {
  const { channel, merchantName, painPoints = [], primaryCohort, cohortTagline, reviews = [] } = req.body || {};
  if (!channel || !merchantName) {
    return res.status(400).json({ error: 'channel and merchantName are required' });
  }
  if (!['banner', 'push', 'whatsapp'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be banner, push, or whatsapp' });
  }

  console.log(`\n[OPENAI] Generating ${channel} copy for ${merchantName}...`);

  const channelSpec = {
    banner: {
      shape:
        'A short, supportive headline (6 to 12 words) plus a 2–3 word CTA. The headline names ONE specific PERSONALISED pain (the pain category PLUS a contextual detail drawn from the reviews — e.g. "unhygiene around the cups", "smoking near the entrance", "service during peak hours") using clear, fluent English — every word must be real and correctly spelled. Use a soft, supportive framing such as "Lost a few regulars to {personalised pain}? Pi can win them back." or "{Personalised pain} weighing on recent reviews? Pi helps bring customers back." NEVER include the merchant name in the headline. NEVER sound accusatory. The verb after "Pi" describes RECOVERY (win back, bring back, alert, reach) — never an operational fix (cook, clean, train, stop). The headline must read as a complete, meaningful English sentence.',
      output: '{ "line": "...", "cta": "..." }',
      examples: [
        'Pain = smoking near entrance (review mentions smokers by the door). Line: "Smoking near the entrance turning regulars away? Pi can win them back." CTA: "Notify Me"',
        'Pain = food quality on cold-coffee specifically. Line: "Cold-coffee freshness weighing on your reviews? Pi sends comeback offers automatically." CTA: "Try Free"',
        'Pain = hygiene around the cups. Line: "Cup cleanliness feedback hurting return visits? Pi flags new complaints in real time." CTA: "Start Now"',
        'Pain = service speed at peak hours. Line: "Long waits during the evening rush? Pi reaches those customers with personalised offers." CTA: "Notify Me"',
        'Pain = visibility / acquisition. Line: "Few new faces walking in lately? Pi puts you on every nearby phone." CTA: "Notify Me"',
      ],
    },
    push: {
      shape:
        'Title (5 to 8 words, 1 emoji) — soft framing that names ONE personalised pain (category + contextual detail from the reviews, e.g. "Smoking near the entrance"). Body (6 to 12 words) MUST mention "Pi" or "Pi Commerce" and describe a RECOVERY action (win-back, comeback offers, real-time alerts) — NOT fixing the operational issue itself. NEVER include the merchant name. Tone is supportive, never accusatory. Every word must be real and correctly spelled.',
      output: '{ "title": "...", "body": "..." }',
      examples: [
        'Pain = smoking near entrance. Title: "Smoking near the entrance noticed 💨" Body: "Pi Commerce can win those customers back with comeback offers."',
        'Pain = cold-coffee freshness. Title: "Cold-coffee freshness flagged in reviews 🍽️" Body: "Pi reaches upset customers and flags new complaints early."',
        'Pain = service at peak hours. Title: "Long waits during evening rush ⏱️" Body: "Pi sends gentle apology offers to customers who walked away."',
        'Pain = visibility / acquisition. Title: "Few new faces this month 👥" Body: "Pi runs hyperlocal banners to bring fresh footfall."',
      ],
    },
    whatsapp: {
      shape:
        'A warm, gentle WhatsApp message TO the merchant — TIGHT and CRISP. Total length: 35–50 words across 5 lines only. Skeleton:\n' +
        '  Line 1: "Namaste {MerchantName}! 🙏"  ← merchant name appears ONLY here.\n' +
        '  Line 2: ONE soft empathy + bridge line (12–18 words) that names 1 PERSONALISED pain (category + contextual detail from the reviews, e.g. "hygiene around the cups", "smoking near the entrance", "long waits at peak hours") and pivots to Pi. Openers to use: "We noticed a few reviews mention {personalised pain} — Pi can\'t fix that side, but it can help bring those customers back:" / "Spotted some {personalised pain} feedback in your reviews. Pi can help win those customers back:" / "A few customers flagged {personalised pain}. Pi can help bring them back and keep you alert:". DO NOT use the merchant name in this line. Use neutral language — no graphic quotes.\n' +
        '  Lines 3-4: exactly 2 bullets (NOT 3), each starts with an emoji, each 5–8 words. Pi-customer-facing recovery actions only. NEVER include the merchant name in bullets.\n' +
        '  Line 5: CTA "👉 Notify Me" or "👉 Start Now".\n' +
        'Pi Commerce is being PITCHED TO the merchant by Paytm — it is NOT the merchant\'s own tool. NEVER promise Pi will fix operational issues. Tone is supportive, never accusatory.',
      output: '{ "message": "...full multi-line text including newlines..." }',
      examples: [
        'Pains = food quality (cold-coffee freshness mentioned in reviews). 5 lines, ~42 words.\n' +
        'Namaste Cold Rock Cafe! 🙏\n' +
        'We noticed some feedback on cold-coffee freshness in recent reviews — Pi can\'t fix the kitchen side, but it can help bring those customers back:\n' +
        '💬 Auto win-back WhatsApp to upset customers\n' +
        '🚨 Real-time alerts when new complaints surface\n' +
        '👉 Notify Me',

        'Pains = smoking + cup cleanliness (operational). 5 lines, ~45 words.\n' +
        'Namaste Spice Garden! 🙏\n' +
        'Spotted some notes on smoking near the entrance and cup cleanliness. Pi can\'t fix that side, but it can help win those customers back:\n' +
        '💬 Personalised comeback offers via WhatsApp\n' +
        '📊 Real-time complaint alerts so you can act early\n' +
        '👉 Notify Me',

        'Pain = visibility gap — short positive reviews, no operational issue. 5 lines, ~40 words.\n' +
        'Namaste Cafe Aurora! 🙏\n' +
        'Your reviews are short and positive but few in number. Pi can help drive fresh footfall and richer feedback:\n' +
        '📢 Hyperlocal Paytm banners to nearby customers\n' +
        '⭐ Nudges that prompt happy customers to share more\n' +
        '👉 Notify Me',
      ],
    },
  };

  const spec = channelSpec[channel];

  const systemPrompt = `You are a Paytm relationship manager talking TO a merchant about THEIR business. You are SELLING them Pi Commerce — Paytm's AI marketing engine that talks to the merchant's customers on the merchant's behalf (auto win-back WhatsApp, personalised comeback offers, real-time complaint alerts, hyperlocal acquisition banners, AI recommendation engine).

WHAT PI COMMERCE IS — AND IS NOT:
Pi Commerce is a CUSTOMER MARKETING tool. It cannot:
- Cook food, fix recipes, change ingredients, or improve quality
- Train, hire, or fire staff
- Clean premises or fix hygiene
- Stop smoking or change ambience
- Fix any operational, kitchen, or service issue
Pi Commerce CAN:
- Win back customers who left because of those issues (via WhatsApp/SMS comeback offers)
- Send personalised apology / loyalty offers to upset customers
- Surface complaints in real-time so the merchant can fix the root cause themselves
- Acquire new customers through hyperlocal Paytm banners
The honest framing is: "Your customers left because of X. Pi can't fix X — that's on you. But Pi CAN help you win those customers back and stay alert when X happens again."

WHO IS TALKING TO WHOM — READ CAREFULLY:
You (Pi Commerce / Paytm) are the SENDER. The merchant is the RECIPIENT. The copy is shown to the merchant in Paytm's dashboard — you are PITCHING Pi Commerce TO the merchant. The merchant is NOT messaging their own customers; Pi will do that for them once they sign up. Pi Commerce is NEVER part of the merchant's brand.

⚠ Therefore: NEVER place the merchant name immediately before or after "Pi" / "Pi Commerce" (writing "Cold Rock Cafe Pi", "Spice Garden Pi", "Pi by Cold Rock" is REJECTED — it makes Pi look like the merchant's own product). The merchant name only appears in the WhatsApp greeting line ("Namaste {MerchantName}! 🙏"). For banner and push, DO NOT include the merchant name at all — the merchant is already viewing this inside their own dashboard, so naming them is redundant and breaks the "Paytm pitching to you" framing.

TONE — VERY IMPORTANT:
You are a HELPFUL partner, not a critic. The merchant has put years into this business. Never sound accusatory, judgmental, or like you're calling out their failures. Mellow, empathetic, supportive. Use openers like "We noticed a few reviews mention…", "Spotted some recent feedback about…", "A handful of customers shared concerns around…" — NOT "Customers complain about…", "Customers mention serious hygiene issues…", "Reviews say your food is bad…". Avoid intensifiers like "serious", "severe", "major", "horrible". Avoid graphic verbatim quotes (cockroach, vomit, etc.) — paraphrase the category instead. Every line should feel like a friend pointing something out gently and offering a hand.

PERSONALISATION — VERY IMPORTANT:
Generic words like "hygiene" or "service" by themselves feel templated. Add ONE specific contextual detail drawn from the actual reviews — a location/area, an object, an item type, a situation, or a time of day — paired with the pain category. Pull this detail from the verbatim quotes or raw review text in the user message; never invent a context that isn't supported.
Examples of personalised pain phrasings (acceptable):
- "hygiene around the serving cups" (when reviews mention cup cleanliness)
- "smoking near the entrance" (when reviews mention smoking by the door)
- "service speed during the evening rush" (when reviews complain about peak-hour wait)
- "ambience in the seating area" (when reviews mention the dining-area atmosphere)
- "food temperature on takeaway orders" (when reviews flag cold takeaway food)
Generic phrasings to AVOID:
- "hygiene concerns" (too vague)
- "service issues" (too vague)
- "food quality" alone (too vague — pair it with what / when / how, e.g. "freshness of the cold-coffee" or "portion sizes at lunch")
The contextual detail must use neutral, fluent English — never a graphic word from the reviews.

NON-NEGOTIABLE RULES:
1. The merchant is the AUDIENCE. You are talking TO them, ABOUT what their customers said. The merchant is NOT messaging their own customers — Pi Commerce will do that for them once they sign up.
2. The copy MUST name at least ONE concrete pain CATEGORY from the input using neutral words ("hygiene", "smoking", "service speed", "food quality", "queue", "staff", "cleanliness"). Use the category word, not a graphic verbatim quote. NEVER fall back to vague phrases like "regulars are slipping" without naming the category.
3. ⚠ NEVER FABRICATE CUSTOMER QUOTES. If you place anything inside quotation marks ("..."), every word inside MUST appear verbatim in the "verbatim quotes" or "raw review text" provided in the user message. PREFER paraphrasing without quotation marks — quotes should be RARE and only used when the customer language is itself mild and constructive. NEVER quote anything graphic (cockroach, vomit, etc.) even if it appears in reviews.
4. NEVER promise Pi will fix the operational problem itself. NEVER write things like "Pi highlights your freshly cooked dishes", "Pi makes service faster", "Pi keeps your place clean", "Pi solves staffing". Those are FALSE PROMISES and will be rejected.
5. For operational pains (food, hygiene, smoking, staff, cleanliness, ambience), the WhatsApp template MUST include a SOFT honest line ("Pi can't fix the {kitchen/staffing/cleaning} side, but it can help you win those customers back:"). Banner and Push are too short for the disclaimer — instead, ensure the verb after "Pi" describes recovery (win back, bring back, alert, reach) NOT operational fix.
6. Bullets / body text must describe CUSTOMER-FACING actions Pi takes: WhatsApp win-back, comeback offers, complaint alerts, hyperlocal acquisition. NEVER kitchen-facing or staff-facing claims.
7. Merchant-name placement (STRICT):
   - WhatsApp: merchant name appears ONLY in the greeting line ("Namaste {MerchantName}! 🙏"). Never in the body, framing line, or bullets.
   - Banner: NEVER include the merchant name. The headline talks ABOUT the situation, never names the merchant.
   - Push: NEVER include the merchant name in the title or body.
   - Never output literal placeholders like "[Name]" or "{MerchantName}" — substitute the real name where it belongs (greeting only).
8. Use REAL, MEANINGFUL words only. Spell every word correctly. No coined or shortened words ("mishygeine", "lol", abbreviations). Every phrase must read naturally to a fluent English speaker.
9. Match the structural template EXACTLY for the requested channel — same length, same line count, same emoji style. No corporate fluff.

REJECTED PATTERN (false promise):
"Saw your reviews — customers say food was overpriced and cold. Pi Commerce can help you fix this: targeted discounts highlighting your best freshly cooked dishes."
WHY REJECTED: Pi cannot make dishes "freshly cooked." That's a kitchen problem.

ACCEPTED PATTERN (honest framing):
"Saw your reviews — customers say food was overpriced and cold. Pi Commerce can't fix the kitchen, but it can help you win them back and stay ahead of complaints: 💬 Auto win-back WhatsApp / 🎁 Personalised comeback offers / 🚨 Real-time alerts when new complaints surface."

Channel requested: ${channel}

Format spec:
${spec.shape}

Examples (mimic the STYLE and the honest framing — do NOT copy wording, write fresh for the merchant in this request):
${spec.examples.map((e, i) => `Example ${i + 1}:\n${e}`).join('\n\n')}

Return a single JSON object in exactly this shape:
${spec.output}`;

  // Heuristic: which pains are operational (Pi can't fix) vs marketing (Pi can address)?
  const OPERATIONAL_KEYWORDS = [
    'food', 'taste', 'cook', 'cold', 'stale', 'fresh', 'quality',
    'hygiene', 'clean', 'dirty', 'smell',
    'smoke', 'smoking', 'ambience', 'noise', 'crowd',
    'staff', 'rude', 'service', 'wait', 'slow', 'queue',
    'parking', 'broken', 'maintenance',
    'price', 'overpriced', 'expensive',
  ];
  const isOperationalPain = (pain) => {
    const s = (pain || '').toLowerCase();
    return OPERATIONAL_KEYWORDS.some(k => s.includes(k));
  };

  const painsBlock = (painPoints || []).slice(0, 5).map((p, i) => {
    const quotes = (p.quotes || []).slice(0, 2).map(q => `"${q.text}"`).join('; ');
    const tag = isOperationalPain(p.pain) ? '[OPERATIONAL — Pi cannot fix this directly, only recover/alert around it]' : '[MARKETING — Pi can address directly]';
    return `${i + 1}. ${p.pain} ${tag} (mentioned in ${p.frequency || '?'} reviews)${quotes ? '\n   verbatim quotes: ' + quotes : ''}`;
  }).join('\n');

  const anyOperational = (painPoints || []).some(p => isOperationalPain(p.pain));

  // Provide the raw reviews so the model has the FULL set of allowed quotation
  // source. Skip rating-only rows since they contain no quotable language.
  const reviewBlock = (reviews || [])
    .filter(r => (r.text || '').trim().length > 0)
    .slice(0, 5)
    .map((r, i) => {
      const author = r.authorName || 'Customer';
      const date = r.date || '';
      return `[${i + 1}] (${author}${date ? ' · ' + date : ''}) ★${r.rating} — ${r.text}`;
    }).join('\n');

  const userMsg =
    `Merchant name (use this verbatim, never a placeholder): ${merchantName}\n` +
    `Primary cohort: ${primaryCohort || 'unknown'} — ${cohortTagline || ''}\n\n` +
    `Pain points from this merchant's actual reviews (you MUST cite at least one by name in the copy):\n${painsBlock || '(none surfaced — write from the raw reviews below using observational language only)'}\n\n` +
    (reviewBlock
      ? `Raw review text (THIS IS THE ONLY SOURCE OF VERBATIM QUOTATIONS — anything you put in quotation marks must appear in this block or the verbatim quotes above):\n${reviewBlock}\n\n`
      : '') +
    (anyOperational
      ? `IMPORTANT: At least one pain above is OPERATIONAL. Pi Commerce CANNOT fix it directly. Use the honest framing — acknowledge the pain, then position Pi as the recovery + visibility layer (win-back, comeback offers, real-time complaint alerts). For the WhatsApp channel specifically, INCLUDE the disclaimer line ("Pi Commerce can't fix the kitchen/staffing/cleaning, but it can help you win them back and stay ahead of complaints:").\n\n`
      : `All pains above are MARKETING-shaped. Pi can address them directly without a disclaimer.\n\n`) +
    `Write the ${channel} copy now. Remember: every quotation mark must wrap text that exists verbatim in the data above.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 700,
        temperature: 0.75,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[OPENAI] Channel-copy API error:', data?.error?.message || data);
      return res.status(r.status).json({ error: data?.error?.message || 'OpenAI request failed' });
    }

    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = safeExtractJson(raw);
    if (!parsed) {
      console.error('[OPENAI] Channel-copy JSON parse failed. Raw:', raw.slice(0, 400));
      return res.status(500).json({ error: 'OpenAI returned malformed JSON' });
    }

    console.log(`[OPENAI] ${channel} copy generated`);
    res.json({ channel, copy: parsed });
  } catch (e) {
    console.error('[OPENAI] Channel-copy exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Merchant Analyzer running → http://localhost:${PORT}\n`);
  console.log('Pipeline:');
  console.log('  POST /api/google/find-place    → Google Places Text Search');
  console.log('  POST /api/google/reviews       → Google Places Details (max 5, sort: most_relevant | newest)');
  console.log('  POST /api/analyze              → GPT-4.1-mini cohort analysis');
  console.log('  POST /api/pain-points          → GPT-4.1-mini pain-point extraction');
  console.log('  POST /api/channel-copy         → GPT-4.1-mini banner/push/whatsapp copy');
  console.log('  POST /api/generate-message     → GPT-4.1-mini WhatsApp draft\n');
});
