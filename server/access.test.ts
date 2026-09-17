import { expect, test } from "bun:test";
import { AccessDenied, canAccess, requireAccess } from "./access";

const env = { owner: "ci", instanceId: "i-preview", members: ["qa"] };

test("owner and explicitly shared QA can access, other users cannot", () => {
  expect(canAccess("ci", env)).toBe(true);
  expect(canAccess("qa", env)).toBe(true);
  expect(canAccess("other", env)).toBe(false);
  expect(requireAccess("qa", "i-preview", [env])).toBe(env);
});

test("unknown instances and missing ids fail closed", () => {
  for (const id of [undefined, "i-other", "", {}])
    expect(() => requireAccess("qa", id, [env])).toThrow(AccessDenied);
});

test("collaborators cannot grant access or perform owner-only lifecycle operations", () => {
  expect(() => requireAccess("qa", "i-preview", [env], true)).toThrow(AccessDenied);
  expect(requireAccess("ci", "i-preview", [env], true)).toBe(env);
});

test("revoking membership immediately removes access", () => {
  expect(() => requireAccess("qa", "i-preview", [{ ...env, members: [] }])).toThrow(AccessDenied);
});
