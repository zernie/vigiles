---
name: generate-logo
description: Generate or iterate on the vigiles logo using ImageRouter or the optional Atlas Cloud provider
---

# Generate Logo

Generate logo variations for vigiles. ImageRouter remains the default provider;
Atlas Cloud is an explicit opt-in alternative for contributors who already use
it.

## Setup

Set the key for the selected provider in the environment. Do NOT pass keys as
arguments or commit them.

| Provider    | Environment variable  | Use when                                       |
| ----------- | --------------------- | ---------------------------------------------- |
| ImageRouter | `IMAGEROUTER_API_KEY` | Default workflow below                         |
| Atlas Cloud | `ATLASCLOUD_API_KEY`  | The contributor explicitly selects Atlas Cloud |

Before a paid request, run the provider's dry run, review the current model
price, and confirm that the prompt contains no confidential information.

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

## Optional Atlas Cloud provider

The bundled helper validates the selected model against Atlas Cloud's live
public catalog and schema before submitting anything. It sends the potentially
billable generation `POST` exactly once, never retries an ambiguous submission,
and only uses bounded retries for prediction `GET` requests.

```bash
node .claude/skills/generate-logo/scripts/generate-atlas-logo.mjs \
  --prompt "YOUR PROMPT HERE" \
  --aspect-ratio 1:1 \
  --resolution 1k \
  --output logo-atlas \
  --dry-run
```

Remove `--dry-run` only after reviewing the payload and current price. The
default model is `google/nano-banana-2/text-to-image-developer`, which matches
the existing Nano Banana 2 workflow. It was available at $0.04 per image in the
live Atlas Cloud catalog on 2026-08-31; availability and pricing can change.

The helper detects PNG, JPEG, or WebP bytes and appends the matching extension
to the output path. Convert the chosen variation to `logo.png` only after visual
review.

## Current logo

The current logo (`logo.png`) is v6: overlapping translucent flame petals on dark background, amber-orange palette. Generated with `google/nano-banana-2`.

### Prompt that produced it

```
A premium, refined logo icon for a developer tool called vigiles that compiles
typed TypeScript specs to AI instruction files. Inspired by OpenAI geometric aesthetic and Apple
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

1. Select ImageRouter, or explicitly opt in to Atlas Cloud
2. Dry-run and review the provider payload and current price
3. Generate variations with different prompts
4. Save as `logo-v*` using the actual image extension (gitignored)
5. Inspect the image dimensions, format, and visual result
6. Pick the best, convert/copy it to `logo.png`
7. Commit `logo.png` only
