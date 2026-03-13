import assert from "node:assert/strict";
import test from "node:test";

import { buildImagineEditFormData } from "../src/routes/function";

test("buildImagineEditFormData reuses uploaded reference images from KV without a public refetch", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    throw new Error("unexpected public refetch");
  }) as typeof fetch;

  try {
    const bytes = new TextEncoder().encode("demo-image");
    const form = await buildImagineEditFormData(
      {
        req: {
          url: "https://demo.example/v1/function/imagine/start",
        },
        env: {
          KV_CACHE: {
            getWithMetadata(key: string) {
              if (key === "image/upload-demo.png") {
                return Promise.resolve({
                  value: bytes.buffer.slice(0),
                  metadata: { contentType: "image/png" },
                });
              }
              return Promise.resolve(null);
            },
          },
        },
      } as any,
      {
        prompt: "test",
        aspect_ratio: "1:1",
        nsfw: null,
        image_reference: ["/images/upload-demo.png"],
        n: 5,
        infinite_mode: false,
      },
    );

    assert.equal(fetchCalls.length, 0);
    const file = form.get("image");
    assert.ok(file instanceof File);
    assert.equal(file.name, "reference.png");
    assert.equal(file.type, "image/png");
    assert.equal(await file.text(), "demo-image");
    assert.equal(form.get("n"), "5");
    assert.equal(form.get("size"), "1024x1024");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildImagineEditFormData appends every uploaded reference image when multiple references are provided", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    throw new Error("unexpected public refetch");
  }) as typeof fetch;

  try {
    const bytesA = new TextEncoder().encode("demo-image-a");
    const bytesB = new TextEncoder().encode("demo-image-b");
    const form = await buildImagineEditFormData(
      {
        req: {
          url: "https://demo.example/v1/function/imagine/start",
        },
        env: {
          KV_CACHE: {
            getWithMetadata(key: string) {
              if (key === "image/upload-demo-a.png") {
                return Promise.resolve({
                  value: bytesA.buffer.slice(0),
                  metadata: { contentType: "image/png" },
                });
              }
              if (key === "image/upload-demo-b.jpg") {
                return Promise.resolve({
                  value: bytesB.buffer.slice(0),
                  metadata: { contentType: "image/jpeg" },
                });
              }
              return Promise.resolve(null);
            },
          },
        },
      } as any,
      {
        prompt: "test",
        aspect_ratio: "3:2",
        nsfw: false,
        image_reference: ["/images/upload-demo-a.png", "/images/upload-demo-b.jpg"],
        n: 2,
        infinite_mode: false,
      },
    );

    assert.equal(fetchCalls.length, 0);
    const files = form.getAll("image");
    assert.equal(files.length, 2);
    assert.ok(files[0] instanceof File);
    assert.ok(files[1] instanceof File);
    assert.equal((files[0] as File).name, "reference-1.png");
    assert.equal((files[0] as File).type, "image/png");
    assert.equal(await (files[0] as File).text(), "demo-image-a");
    assert.equal((files[1] as File).name, "reference-2.jpg");
    assert.equal((files[1] as File).type, "image/jpeg");
    assert.equal(await (files[1] as File).text(), "demo-image-b");
    assert.equal(form.get("n"), "2");
    assert.equal(form.get("size"), "1792x1024");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
