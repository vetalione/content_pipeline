# Google Custom Search API Setup

## Why Google Custom Search?

When Perplexity AI doesn't find direct image URLs in research data, we use Google Custom Search API as a fallback to automatically find relevant images for each fact.

## Cost

- **Free tier**: 100 queries per day
- **Paid**: $5 per 1000 additional queries
- Our usage: ~12 queries per article (one per fact)
- **Free tier covers ~8 articles per day**

## Setup Instructions

### 1. Get Google API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable **Custom Search API**:
   - Menu → "APIs & Services" → "Library"
   - Search for "Custom Search API"
   - Click "Enable"
4. Create API Key:
   - "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "API Key"
   - Copy the key (looks like `AIzaSyB...`)
   - **Optional**: Restrict key to Custom Search API only for security

### 2. Create Programmable Search Engine

1. Go to [Programmable Search Engine](https://programmablesearchengine.google.com/)
2. Click "Add" to create new search engine
3. Configuration:
   - **Sites to search**: Enter `*` (searches entire web)
   - **Name**: "Content Pipeline Images" (or any name)
   - **Language**: Select preferred language
4. After creation, go to "Setup" → "Basic":
   - **Image search**: Turn ON
   - **SafeSearch**: Turn OFF (to find all historical images)
5. Find your **Search engine ID** (cx):
   - It's shown in the "Basics" tab
   - Looks like `a1b2c3d4e5f6g7h8i9j0k`

### 3. Add to Railway Environment Variables

In Railway dashboard for the API service:

```bash
GOOGLE_API_KEY=AIzaSyB...your-api-key...
GOOGLE_CX=a1b2c3...your-search-engine-id...
GOOGLE_GEMINI_API_KEY=AIzaSyD...your-gemini-key...  # For image validation (optional but recommended)
```

### 4. Get Gemini API Key (Optional - for better image accuracy)

**Why**: Gemini Vision validates images to ensure they show the correct celebrity.

1. Go to https://makersuite.google.com/app/apikey
2. Create API key
3. Add to Railway environment variables:
```bash
GOOGLE_GEMINI_API_KEY=AIzaSyD...your-gemini-key...
```

**Cost**: 
- Free tier: 15 requests/minute, 1500/day
- ~12 requests per article (one per fact)
- Free for ~125 articles/day

Without Gemini, system still works but may pick less relevant images.

### 5. Test Locally (Optional)

Add to your `.env` file:

```bash
GOOGLE_API_KEY=AIzaSyB...
GOOGLE_CX=a1b2c3...
GOOGLE_GEMINI_API_KEY=AIzaSyD...  # Optional for validation
```

Run research and check logs for:
```
🔍 Google fallback: searching images for X facts
🔍 Validating 5 image candidates with Gemini...
✅ Best image: https://... (confidence: 95%)
✅ Found image for: [Fact Title]
📸 Total images: X/12
```

## How It Works

1. **Primary**: Perplexity AI searches for `image_url` in research
2. **Fallback**: If `imageUrl` is missing or invalid, Google Custom Search finds it:
   - Constructs query: `{celebrityName} photo {visualSuggestion} {year}`
   - Searches for 5 large .jpg/.png images
   - **Gemini Vision validates each image**: checks if celebrity is visible and matches description
   - Picks best image with confidence >= 70%
3. **Result**: Every fact gets a validated, relevant image

## Monitoring Usage

Check your usage at:
- [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Dashboard
- Monitor daily queries to stay within free tier

## Cost Examples

| Articles/day | Queries/day | Cost/month |
|--------------|-------------|------------|
| 0-8 | 0-100 | $0 (free) |
| 10 | 120 | $0.10 |
| 50 | 600 | $2.50 |
| 100 | 1200 | $5.50 |

## Troubleshooting

**Error: "API key not valid"**
- Check key is copied correctly
- Enable Custom Search API in Google Cloud Console

**Error: "Invalid search engine ID"**
- Check `cx` parameter is correct
- Verify search engine is set to "Search the entire web"

**No images found:**
- Check SafeSearch is OFF in search engine settings
- Try more specific `visualSuggestion` in research data
- Check Railway logs for actual search queries

## Disable Fallback

If you don't want Google fallback, simply don't set the environment variables. The system will work with only Perplexity-found images.
