import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("native chat stream initialization", () => {
  it("prepares persisted Hermes instructions before the delivery transaction", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/app/api/chat/stream/route.ts"),
      "utf8",
    );
    const promptInitialization = source.indexOf(
      'const systemPrompt = useDispatch ? "" : await buildSystemPrompt();',
    );
    const deliveryTransaction = source.indexOf("await tx.connectorDelivery.create({");

    expect(promptInitialization).toBeGreaterThan(-1);
    expect(deliveryTransaction).toBeGreaterThan(-1);
    expect(promptInitialization).toBeLessThan(deliveryTransaction);
  });
});
