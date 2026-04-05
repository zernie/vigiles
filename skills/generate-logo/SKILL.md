---
description: Generate or iterate on the vigiles logo using ImageRouter API
---

# Generate Logo

Generate logo variations for vigiles using the ImageRouter API (imagerouter.io).

## Setup

Get an API key from https://imagerouter.io/api-keys. Pass it as an argument or set `IMAGEROUTER_API_KEY` env var. Do NOT commit the key.

## API

```
Endpoint: https://api.imagerouter.io/v1/openai/images/generations
Auth: Bearer token in Authorization header
Method: POST, Content-Type: application/json
```

### Request body

```json
{
  "prompt": "...",
  "model": "google/nano-banana-2",
  "quality": "high",
  "size": "1024x1024",
  "response_format": "url",
  "output_format": "png"
}
```

### Available models (image generation)

List models: `GET https://api.imagerouter.io/v1/models`

Known good models:

- `google/nano-banana-2` — best quality, $0.07/image
- `google/nano-banana-2:free` — free tier
- `openai/gpt-image-1` — OpenAI's image model
- `black-forest-labs/FLUX-1.1-pro` — FLUX pro

### Response

```json
{
  "created": 1775430873,
  "data": [{ "url": "https://storage.imagerouter.io/..." }],
  "cost": 0.069,
  "latency": 27627
}
```

Download the image from the URL in `data[0].url`.

## Current logo

The current logo (`logo.png`) is v6: overlapping translucent flame petals on dark background, amber-orange palette. Generated with `google/nano-banana-2`.

### Prompt that produced it

```
A premium, refined logo icon for a developer tool called vigiles that validates
AI agent configuration files. Inspired by OpenAI geometric aesthetic and Apple
minimalism. A single abstract geometric shape: an upward-pointing flame composed
of 3 overlapping translucent rounded shapes, creating depth through overlap —
similar to how the OpenAI logo uses overlapping curves. Warm amber to deep orange
color palette. Black background. No text. No letters. Pure abstract mark. Clean
enough to be an app icon. Luxurious, premium, modern tech company feel.
```

## Design principles

- **Flame/torch motif** — vigiles were Rome's night watchmen who carried torches
- **Amber/orange palette** — matches GitHub Action branding color
- **No text in the icon** — must work at 16px favicon size
- **Dark background variant** for README, light/transparent variant for npm

## Example curl

```bash
curl 'https://api.imagerouter.io/v1/openai/images/generations' \
  -H "Authorization: Bearer $IMAGEROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "YOUR PROMPT HERE",
    "model": "google/nano-banana-2",
    "quality": "high",
    "size": "1024x1024",
    "response_format": "url",
    "output_format": "png"
  }'
```

## Workflow

1. Generate variations with different prompts
2. Save as `logo-v*.png` (gitignored)
3. Pick the best, copy to `logo.png`
4. Commit `logo.png` only
