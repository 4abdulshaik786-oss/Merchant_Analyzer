"""
Pi Commerce Merchant Analyzer — Python / FastAPI
Exact 1-to-1 port of server/index.js.
Run: uvicorn server.main:app --host 0.0.0.0 --port 3000
  or: python server/main.py
"""

import csv
import datetime
import json
import os
import pathlib
import re
import warnings
from contextlib import asynccontextmanager
from typing import Any, List, Optional
from urllib.parse import quote as url_quote

import httpx
import psycopg2
import psycopg2.pool
import urllib3
from dotenv import load_dotenv
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── Equivalent to process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' ─────────────
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
warnings.filterwarnings("ignore")

load_dotenv()

# ─── API Keys (loaded from .env) ─────────────────────────────────────────────
GOOGLE_API_KEY      = os.getenv("GOOGLE_API_KEY")
TRUFOUNDRY_TOKEN    = os.getenv("TRUFOUNDRY_TOKEN")
TRUFOUNDRY_MODEL    = os.getenv("TRUFOUNDRY_MODEL", "azure-paytm-east-us/gpt-4.1-mini")
TRUFOUNDRY_BASE_URL = os.getenv(
    "TRUFOUNDRY_BASE_URL",
    "https://llm.tfy.pi.mypaytm.com/api/llm/api/inference/openai",
)
DATABASE_URL = os.getenv("DATABASE_URL", "")

if not GOOGLE_API_KEY:   print("[WARN] GOOGLE_API_KEY missing in .env")
if not TRUFOUNDRY_TOKEN: print("[WARN] TRUFOUNDRY_TOKEN missing in .env")

# ─── PostgreSQL pool (Neon) ───────────────────────────────────────────────────
_db_pool: Optional[psycopg2.pool.ThreadedConnectionPool] = None
_http_client: Optional[httpx.Client] = None


def _pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _db_pool
    if _db_pool is None:
        _db_pool = psycopg2.pool.ThreadedConnectionPool(1, 20, DATABASE_URL)
    return _db_pool


def db_exec(sql: str, params=None, fetch: bool = False):
    """Run a SQL statement; return list-of-dicts when fetch=True."""
    pool = _pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            conn.commit()
            if fetch:
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        return []
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def http() -> httpx.Client:
    """Singleton httpx client with SSL verification off (mirrors NODE_TLS_REJECT_UNAUTHORIZED=0)."""
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(verify=False, timeout=30.0)
    return _http_client


# ─── FastAPI lifespan ─────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    _pool()
    db_exec("""
        CREATE TABLE IF NOT EXISTS merchants (
            merchant_id       TEXT PRIMARY KEY,
            name              TEXT,
            address           TEXT,
            latitude          REAL,
            longitude         REAL,
            cohort            TEXT,
            cohort_tagline    TEXT,
            analysis_summary  TEXT,
            key_insights      TEXT,
            whatsapp_message  TEXT,
            push_notification TEXT,
            banner_copy       TEXT,
            avg_rating        REAL,
            total_reviews     INTEGER,
            reviews_analyzed  INTEGER,
            status            TEXT,
            error_message     TEXT,
            session_id        TEXT,
            processed_at      TEXT
        )
    """)
    print("[PostgreSQL] Database ready → Neon")
    yield
    if _db_pool:
        _db_pool.closeall()
    if _http_client:
        _http_client.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ════════════════════════════════════════════════════════════════════════════
# CONSTANTS — Pi Commerce framework (locked vocabulary + angle list)
# ════════════════════════════════════════════════════════════════════════════

ISSUE_VOCABULARY = [
    "cleanliness", "hygiene", "service", "quality", "freshness",
    "wait time", "pricing", "delivery", "ambiance", "variety",
    "availability", "billing", "seating", "after sales",
    "payment issues", "trust", "safety",
]

VALID_ANGLES = [
    "Negative", "Decline", "LowTraffic", "Neutral",
    "HiddenCeiling", "CompetitorCatchUp", "SilentChurn",
]

VALID_CATEGORIES = [
    "Food & Beverages", "Apparel & Footwear", "Grocery & Kirana",
    "Clinic & Doctor", "Electronics & Technology", "Other",
]

# ─── Helper: tolerant JSON extraction from any LLM response ──────────────────
def safe_extract_json(raw: str) -> Optional[dict]:
    if not raw:
        return None
    s = re.sub(r"```json\s*|```\s*", "", raw, flags=re.IGNORECASE).strip()
    try:
        return json.loads(s)
    except Exception:
        pass
    first = s.find("{")
    last  = s.rfind("}")
    if first != -1 and last > first:
        try:
            return json.loads(s[first:last + 1])
        except Exception:
            pass
    return None


# ─── Helper: normalize any Indian phone format to 0XXXXX XXXXX ───────────────
def normalize_indian_phone(raw) -> Optional[str]:
    if not raw:
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    if digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 10:
        print(f"[PHONE] Unexpected digit count ({len(digits)}) for raw: {raw} — using as-is")
        return str(raw).strip()
    return f"0{digits[:5]} {digits[5:]}"


# ─── Helper: convert any Indian phone to +91XXXXXXXXXX (for findplacefromtext) ─
def to_international_phone(raw) -> Optional[str]:
    if not raw:
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    if digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    return f"+91{digits}"


# ════════════════════════════════════════════════════════════════════════════
# CLASSIFICATION PROMPT
# ════════════════════════════════════════════════════════════════════════════

CLASSIFICATION_SYSTEM_PROMPT = """You analyze Google Maps reviews for a Paytm marketing tool called Pi Commerce. Your job is to read the merchant's reviews and return a STRUCTURED JSON object that downstream code uses to generate WhatsApp, Push, and Banner copy.

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
- When uncertain about the angle → use "SilentChurn"."""

# ════════════════════════════════════════════════════════════════════════════
# TEMPLATE FUNCTIONS — deterministic copy generation (no LLM)
# ════════════════════════════════════════════════════════════════════════════

def capitalize(s: str) -> str:
    if not s:
        return s
    return s[0].upper() + s[1:]


def build_issue_phrase(issues: List[str]) -> Optional[str]:
    if not issues:
        return None
    if len(issues) == 1:
        return issues[0]
    return f"{issues[0]} and {issues[1]}"


def format_rating(rating) -> Optional[str]:
    if rating is None:
        return None
    try:
        n = float(rating)
    except (TypeError, ValueError):
        return None
    return f"{int(n)}.0" if n == int(n) else str(n)


def build_copy(angle: str, issues: List[str], is_severe: bool, rating, merchant_name: str) -> dict:
    issue_phrase = build_issue_phrase(issues)
    issue_word   = issues[0] if issues else None
    rating_str   = format_rating(rating)
    rating_high  = rating_str is not None and float(rating) >= 4.0

    if angle == "Negative":
        if is_severe:
            whatsapp_hook = f"Repeated {issue_phrase} complaints are pushing customers away."
            push_body     = f"Repeated {issue_word} complaints? Pi Commerce brings you more customers. Try Now."
            banner_text   = f"Repeated {issue_word} complaints?"
        else:
            whatsapp_hook = f"{capitalize(issue_phrase)} complaints are pushing customers away."
            push_body     = f"{capitalize(issue_word)} complaints? Pi Commerce brings you more customers. Try Now."
            banner_text   = f"{capitalize(issue_word)} complaints?"
        banner_sub = "Pi Commerce brings you more customers."
        bullet1    = "Brings you more customers"

    elif angle == "Decline":
        whatsapp_hook = "Footfalls not what they used to be?"
        push_body     = "Footfalls slowing down? Pi Commerce brings you more customers. Try Now."
        banner_text   = "Footfalls slowing down?"
        banner_sub    = "Pi Commerce brings you more customers."
        bullet1       = "Brings you more customers"

    elif angle == "LowTraffic":
        whatsapp_hook = "Seeing low footfalls at your place?"
        push_body     = "Low footfalls? Pi Commerce gets you more traffic. Try Now."
        banner_text   = "Low footfalls?"
        banner_sub    = "Pi Commerce gets you more traffic."
        bullet1       = "Gets you more traffic"

    elif angle == "Neutral":
        whatsapp_hook = "Not enough customers walking in?"
        push_body     = "Not enough customers? Pi Commerce brings you more. Try Now."
        banner_text   = "Want more customers?"
        banner_sub    = "Pi Commerce brings you more customers."
        bullet1       = "Brings you more customers"

    elif angle == "HiddenCeiling":
        if rating_high:
            whatsapp_hook = f"You're rated {rating_str} — but hundreds nearby don't know you."
            push_body     = f"Rated {rating_str} but hundreds nearby don't know you? Pi Commerce gets new ones. Try Now."
            banner_text   = f"Rated {rating_str}, but unknown nearby?"
        else:
            whatsapp_hook = "Loved by customers — but hundreds nearby don't know you."
            push_body     = "Loved but unknown nearby? Pi Commerce gets new customers. Try Now."
            banner_text   = "Loved but unknown nearby?"
        banner_sub = "Pi Commerce gets you new customers."
        bullet1    = "Gets you hundreds of new customers"

    elif angle == "CompetitorCatchUp":
        if rating_high:
            whatsapp_hook = f"You're rated {rating_str} — but competition is catching up."
            push_body     = f"Rated {rating_str} & Competition catching up? Pi Commerce gets new customers. Try Now."
            banner_text   = f"Rated {rating_str}, competition catching up?"
        else:
            whatsapp_hook = "Loved by customers — but competition is catching up."
            push_body     = "Competition catching up? Pi Commerce gets new customers. Try Now."
            banner_text   = "Competition catching up?"
        banner_sub = "Pi Commerce gets you new customers."
        bullet1    = "Gets you new customers"

    else:  # SilentChurn (default)
        if rating_high:
            whatsapp_hook = f"You're rated {rating_str} — but are enough new customers finding you?"
            push_body     = f"Rated {rating_str} but want more customers? Pi Commerce brings you more. Try Now."
            banner_text   = f"Rated {rating_str}, want more customers?"
        else:
            whatsapp_hook = "Loved by customers — but are enough new ones finding you?"
            push_body     = "Want more customers? Pi Commerce brings you more. Try Now."
            banner_text   = "Want more customers?"
        banner_sub = "Pi Commerce brings you more customers."
        bullet1    = "Brings you more customers"

    whatsapp = (
        f"Hi {merchant_name},\n\n"
        f"{whatsapp_hook}\n\n"
        f"Pi Commerce:\n"
        f"✅ {bullet1}\n"
        f"✅ No agency or staff needed\n"
        f"✅ Works on its own\n\n"
        f"Launch Now"
    )

    return {
        "whatsapp": whatsapp,
        "push": push_body,
        "banner": {"text": banner_text, "sub": banner_sub},
    }


# ════════════════════════════════════════════════════════════════════════════
# VALIDATION & SANITIZATION
# ════════════════════════════════════════════════════════════════════════════

def sanitize_classification(parsed: dict) -> dict:
    safe_angle    = parsed.get("angle") if parsed.get("angle") in VALID_ANGLES else "SilentChurn"
    safe_category = parsed.get("businessCategory") if parsed.get("businessCategory") in VALID_CATEGORIES else "Other"
    raw_issues    = parsed.get("issues", [])
    safe_issues   = [x for x in (raw_issues if isinstance(raw_issues, list) else [])
                     if x in ISSUE_VOCABULARY][:2]

    final_angle = safe_angle
    if final_angle == "Negative" and not safe_issues:
        final_angle = "SilentChurn"

    return {
        "summary":          parsed.get("summary", "") if isinstance(parsed.get("summary"), str) else "",
        "businessCategory": safe_category,
        "angle":            final_angle,
        "isSevere":         parsed.get("isSevere") is True,
        "issues":           safe_issues,
    }


# ── Column-name aliases → canonical field name (batch CSV) ───────────────────
def normalize_columns(record: dict) -> dict:
    def find(*keys):
        for k in keys:
            hit = next((rk for rk in record if rk.lower() == k.lower()), None)
            if hit is not None:
                return record[hit]
        return None
    return {
        "merchant_id": find("merchant_id", "merchantid", "merchant id", "id"),
        "name":        find("name", "business_name", "businessname", "business name"),
        "phone":       find("phone", "mobile", "phone_number", "contact", "mobile_number"),
        "latitude":    find("latitude", "lat"),
        "longitude":   find("longitude", "lng", "lon", "long"),
    }


# ── CleverTap structured-merchant helpers ─────────────────────────────────────
def split_push(s: str) -> dict:
    if not s:
        return {"title": "", "body": ""}
    q = s.find("?")
    if q != -1 and q < len(s) - 1:
        return {"title": s[:q + 1].strip(), "body": s[q + 1:].strip()}
    m = re.match(r"^(.+?\.)\s+(.+)$", s, re.DOTALL)
    if m:
        return {"title": m.group(1).strip(), "body": m.group(2).strip()}
    return {"title": s.strip(), "body": ""}


def split_banner(s: str) -> dict:
    if not s:
        return {"headline": "", "subtext": ""}
    nl = s.find("\n")
    if nl != -1:
        return {"headline": s[:nl].strip(), "subtext": s[nl + 1:].strip()}
    return {"headline": s.strip(), "subtext": ""}


def split_whatsapp(s: str) -> dict:
    if not s:
        return {"h1": "", "h2": "", "h3": "", "s1": "", "s2": "", "s3": "", "h4": ""}
    lines = [ln.strip() for ln in s.split("\n") if ln.strip()]
    keys  = ["h1", "h2", "h3", "s1", "s2", "s3", "h4"]
    return {k: lines[i] if i < len(lines) else "" for i, k in enumerate(keys)}


def structure_merchant(body: dict, saved_at: str = None) -> dict:
    push   = split_push(body.get("push_notification") or "")
    banner = split_banner(body.get("banner_copy") or "")
    return {
        "merchant_id": body.get("merchant_id"),
        "name":        body.get("name"),
        "profile": {
            "address":  body.get("address") or "",
            "location": {
                "latitude":  str(body.get("latitude") or ""),
                "longitude": str(body.get("longitude") or ""),
            },
        },
        "analysis": {
            "cohort":           body.get("cohort") or "",
            "cohort_tagline":   body.get("cohort_tagline") or "",
            "avg_rating":       body.get("avg_rating"),
            "total_reviews":    body.get("total_reviews"),
            "reviews_analyzed": body.get("reviews_analyzed"),
            "summary":          body.get("analysis_summary") or "",
            "key_insights":     body.get("key_insights") if isinstance(body.get("key_insights"), list) else [],
        },
        "content": {
            "whatsapp": split_whatsapp(body.get("whatsapp_message") or ""),
            "push":     {"title": push["title"], "body": push["body"]},
            "banner":   {"headline": banner["headline"], "subtext": banner["subtext"]},
        },
        "meta": {
            "status":        body.get("status") or "",
            "error_message": body.get("error_message"),
            "processed_at":  body.get("processed_at") or datetime.datetime.utcnow().isoformat(),
            "saved_at":      saved_at or datetime.datetime.utcnow().isoformat(),
        },
    }


def find_merchant(merchant_id: str) -> Optional[dict]:
    try:
        rows = db_exec("SELECT * FROM merchants WHERE merchant_id = %s", (str(merchant_id),), fetch=True)
        if not rows:
            return None
        m = rows[0]
        m["key_insights"] = json.loads(m.get("key_insights") or "[]")
        return m
    except Exception as e:
        print(f"[PostgreSQL] findMerchant error: {e}")
        return None


# ════════════════════════════════════════════════════════════════════════════
# Pydantic request models
# ════════════════════════════════════════════════════════════════════════════

class FindPlaceBody(BaseModel):
    phone: Optional[str] = None
    businessName: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class ReviewsBody(BaseModel):
    placeId: str
    sortOrder: Optional[str] = "most_relevant"
    placeMetadata: Optional[dict] = None


class GenerateCopyBody(BaseModel):
    reviews: List[dict]
    placeMetadata: dict


class FindPlaceByCoordinatesBody(BaseModel):
    phone: Optional[str] = None
    name: Optional[str] = None
    latitude: Optional[Any] = None
    longitude: Optional[Any] = None
    merchant_id: Optional[str] = None


class SaveResultBody(BaseModel):
    session_id: Optional[str] = None
    merchant_id: Optional[str] = None
    name: Optional[str] = None
    address: Optional[str] = None
    latitude: Optional[Any] = None
    longitude: Optional[Any] = None
    cohort: Optional[str] = None
    cohort_tagline: Optional[str] = None
    analysis_summary: Optional[str] = None
    key_insights: Optional[List] = None
    whatsapp_message: Optional[str] = None
    push_notification: Optional[str] = None
    banner_copy: Optional[str] = None
    avg_rating: Optional[float] = None
    total_reviews: Optional[int] = None
    reviews_analyzed: Optional[int] = None
    status: Optional[str] = "pending"
    error_message: Optional[str] = None
    # image fields ignored (not stored)
    whatsapp_image_base64: Optional[str] = None
    push_image_base64: Optional[str] = None
    banner_image_base64: Optional[str] = None


# ════════════════════════════════════════════════════════════════════════════
# GOOGLE PLACES PIPELINE
# ════════════════════════════════════════════════════════════════════════════

# ── POST /api/google/find-place ───────────────────────────────────────────────
@app.post("/api/google/find-place")
def api_find_place(body: FindPlaceBody):
    intl_phone    = to_international_phone(body.phone)
    business_name = body.businessName
    latitude      = body.latitude
    longitude     = body.longitude

    if not intl_phone and not business_name:
        return JSONResponse(status_code=400, content={"error": "phone or businessName is required"})

    has_coords = latitude is not None and longitude is not None

    def search_by_phone(radius: int = 2000):
        url = (
            "https://maps.googleapis.com/maps/api/place/findplacefromtext/json"
            f"?input={url_quote(intl_phone, safe='')}"
            f"&inputtype=phonenumber"
            f"&fields=place_id,name,formatted_address,rating,user_ratings_total"
            + (f"&locationbias=circle:{radius}@{latitude},{longitude}" if has_coords else "")
            + f"&key={GOOGLE_API_KEY}"
        )
        return http().get(url).json()

    def search_by_name(query: str, radius: int = 500):
        url = (
            "https://maps.googleapis.com/maps/api/place/textsearch/json"
            f"?query={url_quote(query, safe='')}"
            + (f"&location={latitude},{longitude}&radius={radius}" if has_coords else "")
            + f"&key={GOOGLE_API_KEY}"
        )
        return http().get(url).json()

    def _norm(s):
        return re.sub(r"[^a-z0-9]", "", (s or "").lower())

    def is_similar(a, b):
        if not a or not b:
            return False
        na, nb = _norm(a), _norm(b)
        return na in nb or nb in na

    def extract_top_candidate(data):
        candidates = data.get("candidates") or []
        if not candidates:
            return None
        top = candidates[0]
        return {
            "placeId":          top.get("place_id"),
            "name":             top.get("name"),
            "formattedAddress": top.get("formatted_address") or "",
            "rating":           top.get("rating"),
            "totalReviews":     top.get("user_ratings_total") or 0,
        }

    def extract_top(data):
        results = data.get("results") or []
        if not results:
            return None
        top = results[0]
        return {
            "placeId":          top.get("place_id"),
            "name":             top.get("name"),
            "formattedAddress": top.get("formatted_address") or "",
            "rating":           top.get("rating"),
            "totalReviews":     top.get("user_ratings_total") or 0,
        }

    try:
        # ── STEP 1: Phone via findplacefromtext (dedicated phone-number lookup) ──
        if intl_phone:
            coord_str = f" @ {latitude},{longitude}" if has_coords else ""
            print(f"\n[MANUAL] Step 1: Phone lookup via findplacefromtext → {intl_phone}{coord_str}")
            data   = search_by_phone(2000)
            count  = len(data.get("candidates") or [])
            print(f"[MANUAL] findplacefromtext status={data.get('status')} candidates={count}")
            result = extract_top_candidate(data)
            if result:
                print(f"[MANUAL] Phone match: {result['name']}")
                return {**result, "matchedBy": "phone"}
            print("[MANUAL] Phone lookup returned no candidates")

        # ── STEP 2: Name fallback via textsearch ──────────────────────────────
        if business_name:
            coord_str = f" @ {latitude},{longitude}" if has_coords else ""
            print(f'\n[MANUAL] Step 2: Name search → "{business_name}"{coord_str}')
            data = search_by_name(business_name, 500)
            if not data.get("results"):
                print("[MANUAL] Name radius=500 empty, retrying 2000")
                data = search_by_name(business_name, 2000)
            result = extract_top(data)
            if result:
                confident = is_similar(business_name, result["name"])
                print(f"[MANUAL] Name match: {result['name']} | similar={confident}")
                return {**result, "matchedBy": "name", "lowConfidence": not confident}
            print("[MANUAL] Name search returned no results")

        # ── STEP 3: Both failed ───────────────────────────────────────────────
        print("[MANUAL] All search attempts failed")
        return JSONResponse(status_code=404, content={
            "error": "No place found — phone lookup and name search both returned no results",
            "matchedBy": None,
        })
    except Exception as e:
        print(f"[MANUAL] Exception: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


# ── POST /api/google/reviews ──────────────────────────────────────────────────
@app.post("/api/google/reviews")
def api_reviews(body: ReviewsBody):
    place_id   = body.placeId
    sort_param = "newest" if body.sortOrder == "newest" else "most_relevant"

    url = (
        "https://maps.googleapis.com/maps/api/place/details/json"
        f"?place_id={url_quote(place_id, safe='')}"
        f"&fields=reviews,name,rating,user_ratings_total"
        f"&reviews_sort={sort_param}"
        f"&key={GOOGLE_API_KEY}"
    )
    print(f"\n[GOOGLE] Details fetch: {place_id} | sort={sort_param}")

    try:
        data   = http().get(url).json()
        result = data.get("result") or {}
        count  = len(result.get("reviews") or [])
        print(f"[GOOGLE] status={data.get('status')} count={count}")

        if data.get("status") != "OK":
            msg = data.get("status", "")
            if data.get("error_message"):
                msg += f" — {data['error_message']}"
            return JSONResponse(status_code=404, content={"error": f"Google Places Details error: {msg}"})

        raw_reviews = result.get("reviews") or []
        reviews = []
        for rev in raw_reviews:
            reviews.append({
                "text":       (rev.get("text") or "").strip(),
                "rating":     str(rev["rating"]) if rev.get("rating") is not None else "?",
                "date":       rev.get("relative_time_description") or (
                    datetime.datetime.utcfromtimestamp(rev["time"]).isoformat()
                    if rev.get("time") else ""
                ),
                "authorName": rev.get("author_name") or "",
            })

        with_text = sum(1 for r in reviews if r["text"])
        print(f"[GOOGLE] Reviews returned: {len(reviews)} ({with_text} with text)")
        if len(reviews) < 5:
            print("[GOOGLE] Note: legacy Places Details API caps at 5 per place under any single sort.")

        merged_meta = body.placeMetadata or {
            "name":         result.get("name"),
            "rating":       result.get("rating"),
            "totalReviews": result.get("user_ratings_total"),
        }

        return {
            "reviews":       reviews,
            "placeMetadata": merged_meta,
            "source":        "google_places",
        }
    except Exception as e:
        print(f"[GOOGLE] Exception: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


# ════════════════════════════════════════════════════════════════════════════
# MAIN ENDPOINT — /api/generate-copy
# ════════════════════════════════════════════════════════════════════════════

@app.post("/api/generate-copy")
def api_generate_copy(body: GenerateCopyBody):
    reviews     = body.reviews
    place_meta  = body.placeMetadata

    if not reviews:
        return JSONResponse(status_code=400, content={"error": "reviews array is required"})
    if not place_meta or not place_meta.get("name"):
        return JSONResponse(status_code=400, content={"error": "placeMetadata with name is required"})

    merchant_name = place_meta["name"]
    rating        = float(place_meta["rating"]) if place_meta.get("rating") is not None else None
    total_reviews = place_meta.get("totalReviews") or len(reviews)

    analyzable   = [r for r in reviews if (r.get("text") or "").strip()]
    review_block = "\n\n".join(
        f"[{i+1}] ★{r['rating']} — {r['text']}"
        for i, r in enumerate(analyzable[:5])
    )

    user_msg = (
        f"Merchant: {merchant_name}\n"
        f"Address: {place_meta.get('formattedAddress') or place_meta.get('address') or ''}\n"
        f"Google rating: {rating if rating is not None else 'unknown'}\n"
        f"Total reviews on Google: {total_reviews}\n\n"
        + (f"Reviews to analyze:\n\n{review_block}" if review_block
           else "No review text available — base your output on the rating and review count alone.")
    )

    rating_display = rating if rating is not None else "–"
    print(f"\n[TRUFOUNDRY] Classifying {merchant_name} | ★{rating_display} · {total_reviews} reviews | {len(analyzable)} review texts | model={TRUFOUNDRY_MODEL}")

    try:
        r = http().post(
            f"{TRUFOUNDRY_BASE_URL}/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {TRUFOUNDRY_TOKEN}",
            },
            json={
                "model":       TRUFOUNDRY_MODEL,
                "max_tokens":  600,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": CLASSIFICATION_SYSTEM_PROMPT},
                    {"role": "user",   "content": user_msg},
                ],
            },
        )
        data = r.json()
        if not r.is_success:
            err = (data.get("error") or {}).get("message") or str(data)
            print(f"[TRUFOUNDRY] Classification API error: {err}")
            return JSONResponse(status_code=r.status_code, content={"error": err})

        raw    = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
        parsed = safe_extract_json(raw)
        if not parsed:
            print(f"[TRUFOUNDRY] Classification JSON parse failed. Raw: {raw[:400]}")
            return JSONResponse(status_code=500, content={"error": "TruFoundry returned malformed JSON"})

        classification = sanitize_classification(parsed)
        copy = build_copy(
            angle=classification["angle"],
            issues=classification["issues"],
            is_severe=classification["isSevere"],
            rating=rating,
            merchant_name=merchant_name,
        )

        print(f"[TRUFOUNDRY] {merchant_name} → angle={classification['angle']} | issues={classification['issues']} | severe={classification['isSevere']}")

        return {
            "classification": classification,
            "copy":           copy,
            "placeMetadata": {
                "name":             merchant_name,
                "rating":           rating,
                "totalReviews":     total_reviews,
                "formattedAddress": place_meta.get("formattedAddress") or place_meta.get("address") or "",
            },
        }
    except Exception as e:
        print(f"[TRUFOUNDRY] Classification exception: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


# ════════════════════════════════════════════════════════════════════════════
# BATCH ENDPOINTS
# ════════════════════════════════════════════════════════════════════════════

# ── GET /api/batch/preview ────────────────────────────────────────────────────
@app.get("/api/batch/preview")
def api_batch_preview():
    csv_path = os.path.join(os.getcwd(), "MerchantData.csv")
    if not os.path.exists(csv_path):
        return JSONResponse(status_code=404, content={"error": "MerchantData.csv not found in project root"})

    try:
        with open(csv_path, newline="", encoding="utf-8") as f:
            records = list(csv.DictReader(f))

        REQUIRED_CSV_COLS = ["merchant_id", "phone", "latitude", "longitude"]
        if records:
            norm    = normalize_columns(records[0])
            missing = [c for c in REQUIRED_CSV_COLS if norm.get(c) is None]
            if missing:
                return JSONResponse(status_code=400, content={
                    "error": f"Missing required column: {', '.join(missing)} in MerchantData.csv"
                })

        merchants = [
            n for n in (normalize_columns(rec) for rec in records)
            if n.get("merchant_id") is not None and n.get("phone") is not None
        ]
        print(f"[BATCH] Loaded {len(merchants)} merchants from MerchantData.csv")
        return {"merchants": merchants, "total": len(merchants)}
    except Exception as e:
        print(f"[BATCH] CSV parse error: {e}")
        return JSONResponse(status_code=500, content={"error": f"CSV parse error: {e}"})


# ── POST /api/batch/find-place-by-coordinates ─────────────────────────────────
@app.post("/api/batch/find-place-by-coordinates")
def api_batch_find_place(body: FindPlaceByCoordinatesBody):
    intl_phone  = to_international_phone(body.phone)
    name        = body.name
    latitude    = body.latitude
    longitude   = body.longitude
    merchant_id = body.merchant_id

    if not intl_phone or latitude is None or longitude is None:
        return JSONResponse(status_code=400, content={
            "error": "phone (valid 10-digit Indian number), latitude, and longitude are required"
        })

    location = f"{latitude},{longitude}"

    def search_by_phone(radius: int = 2000):
        url = (
            "https://maps.googleapis.com/maps/api/place/findplacefromtext/json"
            f"?input={url_quote(intl_phone, safe='')}"
            f"&inputtype=phonenumber"
            f"&fields=place_id,name,formatted_address,rating,user_ratings_total"
            f"&locationbias=circle:{radius}@{location}"
            f"&key={GOOGLE_API_KEY}"
        )
        return http().get(url).json()

    def search_by_name(query: str, radius: int = 500):
        url = (
            "https://maps.googleapis.com/maps/api/place/textsearch/json"
            f"?query={url_quote(query, safe='')}"
            f"&location={location}"
            f"&radius={radius}"
            f"&key={GOOGLE_API_KEY}"
        )
        return http().get(url).json()

    def _norm(s):
        return re.sub(r"[^a-z0-9]", "", (s or "").lower())

    def is_similar(a, b):
        if not a or not b:
            return False
        na, nb = _norm(a), _norm(b)
        return na in nb or nb in na

    def extract_top_candidate(data):
        candidates = data.get("candidates") or []
        if not candidates:
            return None
        top = candidates[0]
        return {
            "placeId":          top.get("place_id"),
            "name":             top.get("name"),
            "formattedAddress": top.get("formatted_address") or "",
            "rating":           top.get("rating"),
            "totalReviews":     top.get("user_ratings_total") or 0,
        }

    def extract_top(data):
        results = data.get("results") or []
        if not results:
            return None
        top = results[0]
        return {
            "placeId":          top.get("place_id"),
            "name":             top.get("name"),
            "formattedAddress": top.get("formatted_address") or "",
            "rating":           top.get("rating"),
            "totalReviews":     top.get("user_ratings_total") or 0,
        }

    try:
        # ── STEP 1: Phone via findplacefromtext ────────────────────────────
        print(f"\n[BATCH {merchant_id}] Step 1: Phone lookup via findplacefromtext → {intl_phone}")
        phone_data   = search_by_phone(2000)
        cand_count   = len(phone_data.get("candidates") or [])
        print(f"[BATCH {merchant_id}] findplacefromtext status={phone_data.get('status')} candidates={cand_count}")
        phone_result = extract_top_candidate(phone_data)
        if phone_result:
            print(f"[BATCH {merchant_id}] Phone match: {phone_result['name']} | matchedBy=phone")
            return {**phone_result, "matchedBy": "phone"}
        print(f"[BATCH {merchant_id}] Phone lookup returned no candidates")

        # ── STEP 2: Name + coordinates fallback ────────────────────────────
        if name:
            print(f"[BATCH {merchant_id}] Step 2: Name search → {name}")
            data = search_by_name(name, 500)
            if not data.get("results"):
                print(f"[BATCH {merchant_id}] Name radius=500 empty, retrying 2000")
                data = search_by_name(name, 2000)
            result = extract_top(data)
            if result:
                confident = is_similar(name, result["name"])
                print(f"[BATCH {merchant_id}] Name match: {result['name']} | similar={confident}")
                return {**result, "matchedBy": "name", "lowConfidence": not confident}

        # ── STEP 3: Both failed ────────────────────────────────────────────
        print(f"[BATCH {merchant_id}] Phone lookup and name search both failed")
        return JSONResponse(status_code=404, content={
            "error": "Place not found — phone lookup and name search both returned no results",
            "matchedBy": None,
        })
    except Exception as e:
        print(f"[BATCH {merchant_id}] find-place error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


# ── POST /api/batch/save-result ───────────────────────────────────────────────
@app.post("/api/batch/save-result")
def api_batch_save_result(body: SaveResultBody):
    try:
        db_exec("""
            INSERT INTO merchants (
                merchant_id, name, address, latitude, longitude,
                cohort, cohort_tagline, analysis_summary,
                key_insights, whatsapp_message, push_notification,
                banner_copy, avg_rating, total_reviews,
                reviews_analyzed, status, error_message,
                session_id, processed_at
            )
            VALUES (
                %s, %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s
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
        """, (
            str(body.merchant_id),
            body.name,
            body.address,
            body.latitude,
            body.longitude,
            body.cohort,
            body.cohort_tagline,
            body.analysis_summary,
            json.dumps(body.key_insights or []),
            body.whatsapp_message,
            body.push_notification,
            body.banner_copy,
            body.avg_rating,
            body.total_reviews,
            body.reviews_analyzed,
            body.status or "pending",
            body.error_message,
            str(body.session_id or ""),
            datetime.datetime.utcnow().isoformat(),
        ))

        rows  = db_exec("SELECT COUNT(*) as count FROM merchants", fetch=True)
        total = rows[0]["count"] if rows else 0
        print(f"[BATCH {body.merchant_id}] Saved to PostgreSQL | Total: {total}")
        return {"saved": True, "total_saved": total}
    except Exception as e:
        print(f"[PostgreSQL] Save error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


# ── GET /api/batch/export-data?sessionId=xxx ─────────────────────────────────
@app.get("/api/batch/export-data")
def api_batch_export(sessionId: str = Query(...)):
    try:
        rows = db_exec(
            "SELECT * FROM merchants WHERE session_id = %s",
            (str(sessionId),),
            fetch=True,
        )
        results = []
        for r in rows:
            r["key_insights"] = json.loads(r.get("key_insights") or "[]")
            results.append(r)
        return {
            "results":    results,
            "total":      len(results),
            "successful": sum(1 for r in results if r.get("status") == "success"),
            "failed":     sum(1 for r in results if r.get("status") == "failed"),
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ════════════════════════════════════════════════════════════════════════════
# CLEVERTAP LINKED CONTENT API
# ════════════════════════════════════════════════════════════════════════════

# ── GET /api/v1/merchants/{merchant_id} ───────────────────────────────────────
@app.get("/api/v1/merchants/{merchant_id}")
def api_merchant(merchant_id: str):
    print(f"[CLEVERTAP] Fetching data for merchant_id: {merchant_id}")
    m = find_merchant(merchant_id)
    if not m:
        return JSONResponse(status_code=404, content={"error": "Merchant not found"})
    return structure_merchant(m, m.get("processed_at"))


# ── GET /api/clevertap/whatsapp?merchant_id=xxx ───────────────────────────────
@app.get("/api/clevertap/whatsapp")
def api_clevertap_whatsapp(merchant_id: str = Query(...)):
    m = find_merchant(merchant_id)
    if not m:
        return JSONResponse(status_code=404, content={"error": f"Merchant {merchant_id} not found"})
    return {
        "merchant_id":       m["merchant_id"],
        "business_name":     m.get("name"),
        "pi_commerce_angle": m.get("cohort"),
        "message":           m.get("whatsapp_message"),
    }


# ── GET /api/clevertap/push?merchant_id=xxx ───────────────────────────────────
@app.get("/api/clevertap/push")
def api_clevertap_push(merchant_id: str = Query(...)):
    m = find_merchant(merchant_id)
    if not m:
        return JSONResponse(status_code=404, content={"error": f"Merchant {merchant_id} not found"})
    push_notif = m.get("push_notification") or ""
    return {
        "merchant_id":       m["merchant_id"],
        "business_name":     m.get("name"),
        "pi_commerce_angle": m.get("cohort"),
        "title":             push_notif.split(".")[0] if push_notif else push_notif,
        "body":              push_notif,
    }


# ── GET /api/clevertap/banner?merchant_id=xxx ─────────────────────────────────
@app.get("/api/clevertap/banner")
def api_clevertap_banner(merchant_id: str = Query(...)):
    m = find_merchant(merchant_id)
    if not m:
        return JSONResponse(status_code=404, content={"error": f"Merchant {merchant_id} not found"})
    banner = m.get("banner_copy") or ""
    return {
        "merchant_id":       m["merchant_id"],
        "business_name":     m.get("name"),
        "pi_commerce_angle": m.get("cohort"),
        "headline":          banner.split(".")[0] if banner else banner,
        "subtext":           banner,
    }


# ── Static files — must be mounted last so API routes take precedence ─────────
_PUBLIC_DIR = str(pathlib.Path(__file__).parent.parent / "public")
app.mount("/", StaticFiles(directory=_PUBLIC_DIR, html=True), name="static")


# ════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn

    print(f"\n✅ Pi Commerce Merchant Analyzer running → http://localhost:3000\n")
    print("Pipeline:")
    print("  POST /api/google/find-place          → Google Places Text Search")
    print("  POST /api/google/reviews             → Google Places Details (max 5)")
    print(f"  POST /api/generate-copy              → TruFoundry ({TRUFOUNDRY_MODEL}): classify + generate copy")
    print("  GET  /api/v1/merchants/:merchant_id  → CleverTap Linked Content")
    print("  GET  /api/clevertap/whatsapp         → WhatsApp message")
    print("  GET  /api/clevertap/push             → Push notification")
    print("  GET  /api/clevertap/banner           → Banner copy\n")

    uvicorn.run("main:app", host="0.0.0.0", port=3000, reload=False)
