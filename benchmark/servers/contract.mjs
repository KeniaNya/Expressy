// Shared constants for every server so responses are byte-for-byte comparable.
// Plain JS so both Node and Bun can import it (Express runs on both).
export const PORT = Number(process.env.PORT ?? 3100);

// A deterministic 100-element array. Every framework serializes the SAME data,
// so the JSON-serialization scenario measures the framework, not the payload.
export const LARGE_PAYLOAD = Array.from({ length: 100 }, (_, i) => ({
  id: i,
  name: `item-${i}`,
  active: i % 2 === 0,
  score: (i * 37) % 100,
  tags: ["alpha", "beta", "gamma"],
}));
