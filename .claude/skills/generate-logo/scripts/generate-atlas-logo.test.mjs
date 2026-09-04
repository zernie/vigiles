import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_MODEL,
  detectImage,
  generateAtlasLogo,
} from "./generate-atlas-logo.mjs";

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

test("submits one paid request, polls with auth, and writes detected image", async () => {
  const calls = [];
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/models")) {
      return jsonResponse({
        data: [
          {
            model: DEFAULT_MODEL,
            display_console: true,
            type: "Image",
            schema: "https://example.test/schema.json",
          },
        ],
      });
    }
    if (url.endsWith("/schema.json")) {
      return jsonResponse({
        components: {
          schemas: {
            Input: {
              properties: { model: {}, prompt: {}, aspect_ratio: {} },
            },
          },
        },
      });
    }
    if (options.method === "POST") {
      return jsonResponse({ code: 200, data: { id: "prediction-test" } });
    }
    if (url.includes("/model/prediction/")) {
      return jsonResponse({
        code: 200,
        data: {
          status: "completed",
          outputs: ["https://example.test/logo"],
        },
      });
    }
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return png;
      },
    };
  };

  const directory = await mkdtemp(join(tmpdir(), "vigiles-atlas-logo-"));
  const result = await generateAtlasLogo({
    apiKey: "test-key",
    payload: {
      model: DEFAULT_MODEL,
      prompt: "amber torch",
      aspect_ratio: "1:1",
    },
    output: join(directory, "logo-v7"),
    pollIntervalMs: 0,
    timeoutMs: 100,
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.imageType, "PNG");
  assert.equal(result.output, join(directory, "logo-v7.png"));
  assert.deepEqual(await readFile(result.output), png);
  assert.equal(
    calls.filter((call) => call.options.method === "POST").length,
    1,
  );
  const poll = calls.find((call) => call.url.includes("/model/prediction/"));
  assert.equal(poll.options.headers.Authorization, "Bearer test-key");
});

test("detects supported image signatures", () => {
  assert.equal(detectImage(Buffer.from("89504e470d0a1a0a", "hex")), "PNG");
  assert.equal(detectImage(Buffer.from("ffd8ff00", "hex")), "JPEG");
  assert.equal(detectImage(Buffer.from("RIFF0000WEBP", "ascii")), "WebP");
});
