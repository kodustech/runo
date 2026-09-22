import { expect, test } from "bun:test";
import { slugFor, slugify, validateProfile } from "./config";

test("a profile joins the slug; no profile keeps the old slug byte for byte", () => {
  expect(slugFor("task/checkout-fix")).toBe(slugify("task/checkout-fix"));
  expect(slugFor("task/checkout-fix", "cloud")).toBe("task-checkout-fix-cloud");
  expect(slugFor("fix/Test", "self-hosted")).toBe("fix-test-self-hosted");
});

test("profiles are DNS-label safe", () => {
  expect(validateProfile(" Cloud ")).toBe("cloud");
  expect(validateProfile("self-hosted")).toBe("self-hosted");
  for (const bad of ["", "self hosted", "cloud/", "-x", "x-", "a".repeat(40), "ção"])
    expect(() => validateProfile(bad)).toThrow(/Invalid profile/);
});
