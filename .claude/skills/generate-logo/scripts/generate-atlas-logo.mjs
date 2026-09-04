#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CATALOG_URL = "https://api.atlascloud.ai/api/v1/models";
export const DEFAULT_API_BASE = "https://api.atlascloud.ai/api/v1";
export const DEFAULT_MODEL = "google/nano-banana-2/text-to-image-developer";

const SUCCESS = new Set(["completed", "succeeded", "success"]);
const FAILURE = new Set(["failed", "canceled", "cancelled"]);
const EXTENSIONS = { PNG: ".png", JPEG: ".jpg", WebP: ".webp" };

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function assertResponse(response, url) {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response;
}

export async function getJson(
  url,
  { headers = {}, attempts = 3, fetchImpl = fetch, sleep = delay } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: "GET", headers });
      return await assertResponse(response, url).json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  throw new Error(`GET failed after ${attempts} attempts: ${url}`, {
    cause: lastError,
  });
}

export async function validateLiveModel(
  modelId,
  requestedFields,
  { fetchImpl = fetch, sleep = delay } = {},
) {
  const catalog = await getJson(CATALOG_URL, { fetchImpl, sleep });
  const model = (catalog.data ?? []).find((item) => item.model === modelId);
  if (!model)
    throw new Error(`Model is missing from the live catalog: ${modelId}`);
  if (model.display_console !== true)
    throw new Error(`Model is not public: ${modelId}`);
  if (model.type !== "Image")
    throw new Error(`Model is not an image model: ${modelId}`);
  if (!model.schema) throw new Error(`Model has no live schema: ${modelId}`);

  const schema = await getJson(model.schema, { fetchImpl, sleep });
  const properties =
    schema.components?.schemas?.Input?.properties ?? Object.create(null);
  const missing = [...requestedFields].filter(
    (field) => !(field in properties),
  );
  if (missing.length > 0) {
    throw new Error(
      `Live model schema does not support: ${missing.join(", ")}`,
    );
  }
  return model;
}

function firstOutputUrl(data) {
  const outputs = data.outputs ?? data.output ?? [];
  if (typeof outputs === "string") return outputs;
  const first = Array.isArray(outputs) ? outputs[0] : undefined;
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    if (typeof first.url === "string") return first.url;
    if (typeof first.image_url === "string") return first.image_url;
  }
  throw new Error("Atlas prediction completed without an output URL");
}

export function detectImage(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "PNG";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "JPEG";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "WebP";
  }
  throw new Error("Downloaded output is not a PNG, JPEG, or WebP image");
}

function outputPathFor(requestedPath, imageType) {
  const expected = EXTENSIONS[imageType];
  const current = extname(requestedPath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(current)) {
    return requestedPath.slice(0, -current.length) + expected;
  }
  return requestedPath + expected;
}

export async function generateAtlasLogo({
  apiKey,
  payload,
  output,
  apiBase = DEFAULT_API_BASE,
  pollIntervalMs = 5_000,
  timeoutMs = 600_000,
  fetchImpl = fetch,
  sleep = delay,
}) {
  await validateLiveModel(payload.model, new Set(Object.keys(payload)), {
    fetchImpl,
    sleep,
  });

  const authorization = { Authorization: `Bearer ${apiKey}` };
  const submitUrl = `${apiBase.replace(/\/$/, "")}/model/generateImage`;

  // This request may be billable and is intentionally never retried.
  const submissionResponse = await fetchImpl(submitUrl, {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const submission = await assertResponse(submissionResponse, submitUrl).json();
  if (![undefined, null, 200, "200"].includes(submission.code)) {
    throw new Error(
      submission.msg ?? submission.message ?? "Atlas submission failed",
    );
  }
  const predictionId = submission.data?.id;
  if (!predictionId) throw new Error("Atlas submission did not return data.id");

  const predictionUrl = `${apiBase.replace(/\/$/, "")}/model/prediction/${encodeURIComponent(predictionId)}`;
  const deadline = Date.now() + timeoutMs;
  let imageUrl;
  while (Date.now() < deadline) {
    const prediction = await getJson(predictionUrl, {
      headers: authorization,
      fetchImpl,
      sleep,
    });
    const data = prediction.data ?? {};
    const status = String(data.status ?? "").toLowerCase();
    if (SUCCESS.has(status)) {
      imageUrl = firstOutputUrl(data);
      break;
    }
    if (FAILURE.has(status)) {
      throw new Error(
        `Atlas generation failed: ${data.error ?? data.message ?? status}`,
      );
    }
    await sleep(pollIntervalMs);
  }
  if (!imageUrl)
    throw new Error(`Timed out waiting for prediction ${predictionId}`);

  const imageResponse = await fetchImpl(imageUrl, { method: "GET" });
  const imageBytes = Buffer.from(
    await assertResponse(imageResponse, imageUrl).arrayBuffer(),
  );
  const imageType = detectImage(imageBytes);
  const finalPath = resolve(outputPathFor(output, imageType));
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(finalPath, imageBytes);
  return { output: finalPath, imageType, model: payload.model };
}

function parseArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    output: "logo-atlas",
    pollIntervalMs: 5_000,
    timeoutMs: 600_000,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === "--prompt") options.prompt = value;
    else if (argument === "--model") options.model = value;
    else if (argument === "--aspect-ratio") options.aspectRatio = value;
    else if (argument === "--resolution") options.resolution = value;
    else if (argument === "--seed") options.seed = Number.parseInt(value, 10);
    else if (argument === "--output") options.output = value;
    else if (argument === "--poll-interval") {
      options.pollIntervalMs = Number(value) * 1_000;
    } else if (argument === "--timeout") {
      options.timeoutMs = Number(value) * 1_000;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.prompt) throw new Error("--prompt is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = { model: options.model, prompt: options.prompt };
  if (options.aspectRatio) payload.aspect_ratio = options.aspectRatio;
  if (options.resolution) payload.resolution = options.resolution;
  if (Number.isInteger(options.seed)) payload.seed = options.seed;

  if (options.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const apiKey = process.env.ATLASCLOUD_API_KEY?.trim();
  if (!apiKey)
    throw new Error("ATLASCLOUD_API_KEY is required unless --dry-run is used");
  const result = await generateAtlasLogo({
    apiKey,
    payload,
    output: options.output,
    apiBase: process.env.ATLASCLOUD_API_BASE_URL ?? DEFAULT_API_BASE,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs,
  });
  console.log(`${result.output} (${result.imageType}, ${result.model})`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
