# Merchant Review Analyzer

Paste a Google Maps URL → scrapes reviews via Apify → GPT-4.1-mini analyzes → categorizes merchant into cohorts.

## Setup (one time)

1. Make sure you have **Node.js** installed (https://nodejs.org)
2. Open Terminal / Command Prompt in this folder
3. Run:

```
npm install
```

## Run the app

```
npm start
```

Then open your browser at: **http://localhost:3000**

## How it works

1. You paste a Google Maps merchant URL
2. The server calls Apify to scrape reviews (takes 1-2 min)
3. Reviews are sent to GPT-4.1-mini for analysis
4. App shows which of the 6 cohorts the merchant falls into:
   - Acquisition gap
   - Retention / Win-back
   - Frequency
   - Off-peak imbalance
   - Competitive loss
   - Personalization gap
