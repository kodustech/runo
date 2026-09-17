import { expect, test } from "bun:test";
import { verifyIdentity } from "./identity";
const agent = "arn:aws:iam::611816806956:user/kodus-devops-agent";
test("same account does not make the production identity acceptable", () => {
  expect(() => verifyIdentity("arn:aws:iam::611816806956:user/kodusDevopsadminGithub", "us-east-2", agent, "us-east-2")).toThrow("identity mismatch");
});
test("correct identity in a different region is refused", () => {
  expect(() => verifyIdentity(agent, "sa-east-1", agent, "us-east-2")).toThrow("region mismatch");
});
test("isolated identity and Ohio are accepted", () => {
  expect(() => verifyIdentity(agent, "us-east-2", agent, "us-east-2")).not.toThrow();
});
