import { test, expect } from "@playwright/test";

// Smoke test: the Worker boots and Mastra serves the agent over its REST API.
// `templateUrl` is provided by the cloudflare/templates test harness; locally
// it defaults to the dev server origin.
test("serves the assistant agent over the Mastra API", async ({ request }) => {
  const res = await request.get("/api/agents");
  expect(res.ok()).toBeTruthy();

  const body = await res.json();
  expect(body).toHaveProperty("assistant");
  expect(body.assistant.name).toBe("Assistant");
});
