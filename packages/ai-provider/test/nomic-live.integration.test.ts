import { describe, expect, it } from "vitest";
import { NomicEmbeddingProvider } from "../src/index.ts";

const baseUrl = process.env.HOBBO_EMBEDDING_BASE_URL ?? "http://127.0.0.1:8087";
const modelId = process.env.HOBBO_EMBEDDING_MODEL_ID ?? "hobbo-embeddings";
const expectedDimensions = Number(
  process.env.HOBBO_EMBEDDING_EXPECTED_DIMENSIONS ?? "768",
);

function expectValidVector(vector: readonly number[]): void {
  expect(vector).toHaveLength(expectedDimensions);
  expect(vector.some((value) => value !== 0)).toBe(true);
  expect(vector.every((value) => Number.isFinite(value))).toBe(true);
}

describe("NomicEmbeddingProvider live llama.cpp contract", () => {
  it("embeds both search documents and search queries through the real provider", async () => {
    const provider = new NomicEmbeddingProvider({
      baseUrl,
      modelId,
      expectedDimensions,
    });

    const document = await provider.embed({
      purpose: "document",
      inputs: [
        "el personaje tiene hambre elevada y posee comida disponible",
      ],
    });
    const query = await provider.embed({
      purpose: "query",
      inputs: [
        "personaje con hambre buscando una solución inmediata",
      ],
    });

    expect(document.providerId).toBe("nomic-openai-compatible");
    expect(document.modelId).toBe(modelId);
    expect(query.providerId).toBe("nomic-openai-compatible");
    expect(query.modelId).toBe(modelId);
    expect(document.vectors).toHaveLength(1);
    expect(query.vectors).toHaveLength(1);

    expectValidVector(document.vectors[0]!);
    expectValidVector(query.vectors[0]!);
  });
});
