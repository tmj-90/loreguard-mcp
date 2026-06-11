import { describe, expect, it } from "vitest";

import { scanForSecrets, scanLoreFields } from "../src/core/secrets.js";

describe("core/secrets — scanForSecrets", () => {
  it("returns nothing for clean prose, including security conventions", () => {
    // The crucial property for THIS tool: notes ABOUT secrets must not trip
    // the guard, or every legitimate record gets blocked.
    expect(scanForSecrets("Use Argon2id for password hashing; m=64MB.")).toEqual([]);
    expect(scanForSecrets("Rotate API keys every 90 days. Never log auth headers.")).toEqual([]);
    expect(scanForSecrets("")).toEqual([]);
  });

  it("flags an AWS access key id", () => {
    const hits = scanForSecrets("creds: AKIAIOSFODNN7EXAMPLE in the old config");
    expect(hits.map((h) => h.type)).toContain("AWS access key id");
  });

  it("flags a GitHub token and masks it", () => {
    const tok = "ghp_" + "a".repeat(36);
    const hits = scanForSecrets(`token=${tok}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.type).toBe("GitHub token");
    expect(hits[0]!.redacted).not.toContain(tok);
    expect(hits[0]!.redacted).toContain("…");
  });

  it("flags a private key block", () => {
    const hits = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
    expect(hits.map((h) => h.type)).toContain("Private key block");
  });

  it("flags a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH1234";
    expect(scanForSecrets(jwt).map((h) => h.type)).toContain("JWT");
  });

  it("flags a Stripe live key but not a test key", () => {
    expect(
      scanForSecrets("sk_live_" + "a".repeat(24)).map((h) => h.type),
    ).toContain("Stripe live key");
    expect(scanForSecrets("sk_test_abc123")).toEqual([]);
  });

  it("dedupes a token that appears twice", () => {
    const tok = "ghp_" + "b".repeat(36);
    expect(scanForSecrets(`${tok} ... ${tok}`)).toHaveLength(1);
  });

  it("scanLoreFields scans title + summary + body together", () => {
    const hits = scanLoreFields({
      title: "DB notes",
      summary: "all good",
      body: "leftover: AKIAIOSFODNN7EXAMPLE",
    });
    expect(hits).toHaveLength(1);
  });
});
