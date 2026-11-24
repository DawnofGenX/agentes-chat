import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { LOGIN_PER_AGENT } from "@agenteschat/client/lib/plans";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { brainDialog, brainRows, brainScreen, pickRow, toScreen } from "./ai-picker";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { shownText } from "./hint";
import { renderApp, settle } from "./render";

/*
 * "Quem pensa" with other people's agents and accounts (ADR 0032 §5, addendum 2026-11-10; ADR 0059 §3): an admin on
 * someone else's agent picks among that owner's accounts and the workspace's keys, never signs one in there; switching
 * everyone on an account moves each agent by the server's own rules, and one it refuses is named.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

const account = (patch: Partial<MachineAccount> & Pick<MachineAccount, "id" | "label">): MachineAccount => ({
  kind: "claude_code",
  email: `${patch.id}@acme.com`,
  plan: "max",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  ...patch,
});

/** Ada on the MacBook, thinking with `view`'s account; `owner`: who owns Ada and Atlas. */
async function ada(view: Partial<AgentBrain>, owner = "u-walter") {
  const state = seedState();
  for (const a of state.agents)
    if (a.id === ADA_ID || a.id === ATLAS_ID) {
      a.ownerUserId = owner;
      a.brain = { kind: "claude_code", model: "Sonnet", account: "Claude Max" };
    }
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook", os: "darwin" });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
  const brain = fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", onlyOwner: true, ...view });
  api.agents.brain = async (_orgId, agentId) => structuredClone({ ...brain, agentId });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api };
}

describe("an admin on someone else's agent", () => {
  test("picks among the owner's accounts it may use and the keys; locked ones stay off, nothing to sign in or connect", async () => {
    const theirs = account({
      id: "acct_joao",
      label: "Claude Max",
      ownerId: "u-joao",
      ownerName: "João Silva",
      mine: false,
      usedBy: ["Ada"],
    });
    const other = account({
      id: "acct_joao2",
      label: "Claude Pro",
      ownerId: "u-joao",
      ownerName: "João Silva",
      mine: false,
    });
    const admin = { canUsePlans: false, canManageAccounts: false, ownSignIn: false };
    await ada({ account: "acct_joao", accounts: [theirs, other], ...admin }, "u-joao");
    const d = await brainDialog("Quem pensa pela Ada");
    // Whose accounts these are, said on the first screen.
    expect(shownText(d)).toContain("Só contas de João");
    await toScreen(d, "Trocar de conta");
    // The one in use; by AI, João's other account, his to give: saying whose it is, not to be picked; the workspace's
    // key, the admin's to pick. Only the one in use shows picked: a row saves once pressed.
    const rows = brainRows(d);
    expect(rows.map((r) => [r.group, r.title, r.checked, r.off])).toEqual([
      ["Em uso", "Claude Max", true, false],
      ["Claude", "Claude Pro · Max", false, true],
      ["Chaves de API", "Chave padrão do workspace", false, false],
    ]);
    expect(rows[1]?.lines).toEqual(["De João"]);
    // No sign-in here and no other AI to connect: those are the owner's (ADR 0160, addendum).
    expect(within(d).queryByRole("button", { name: /^Conectar outra IA/ })).toBeNull();
    expect(within(d).queryByRole("button", { name: /^Entrar/ })).toBeNull();
  });
});

describe("Todos nesta conta", () => {
  test("each agent on the account moves by the server's rules; one it refuses keeps its account and is named", async () => {
    const shared = account({
      id: "acct_team",
      label: "Claude Max",
      shared: true,
      usedBy: ["Ada", "Atlas"],
      usedByIds: [ADA_ID, ATLAS_ID],
    });
    const next = account({ id: "acct_next", label: "Claude Team", email: "next@acme.com", plan: "team", shared: true });
    const { state, api } = await ada({ account: "acct_team", accounts: [shared, next] });
    const setBrain = api.agents.setBrain;
    const asked: unknown[] = [];
    api.agents.setBrain = async (orgId, agentId, input) => {
      if (agentId !== ATLAS_ID) return setBrain(orgId, agentId, input);
      asked.push(input);
      throw new ApiError(409, "agent.brain_refused", "Not on this account");
    };
    const d = await brainDialog("Quem pensa pela Ada");
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "next@acme.com");
    // The account thinks for both: whom the switch is for, everyone by default.
    expect(brainScreen(d)).toBe("Trocar a conta do time");
    const cards = within(d).getByRole("group", { name: "Para quem é" });
    expect(
      within(cards)
        .getByRole("button", { name: /^Todos nesta conta/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // Whom each card covers is its description, behind an ⓘ: the role alone, or every agent on the account.
    expect(cards.querySelectorAll(".ac-option__desc")).toHaveLength(0);
    expect(
      within(cards)
        .getByRole("button", { name: /^Só a Ada/ })
        .getAttribute("aria-description"),
    ).toBe("Dev");
    expect(
      within(cards)
        .getByRole("button", { name: /^Todos nesta conta/ })
        .getAttribute("aria-description"),
    ).toBe("Ada · Dev\nAtlas · Ops");
    await click(within(d).getByRole("button", { name: "Trocar os 2 agentes" }));
    await settle(6);
    // Ada moved; Atlas was asked for the account alone (the model it has stays its own) and refused.
    expect(state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID]);
    expect(asked).toEqual([{ brain: "claude_code", account: "acct_next" }]);
    expect(brainScreen(d)).toBe("Pronto");
    expect(shownText(d)).toContain("Atlas ficou com a conta de antes.");
  });
});

describe("a login another agent thinks with", () => {
  test("taken for Ada, Pronto says Atlas lost it; Desfazer puts Ada back, then gives the login back to Atlas", async () => {
    // A plan whose account has one login: picking another agent's takes it instead of signing in once more.
    const was = LOGIN_PER_AGENT.claude_code;
    (LOGIN_PER_AGENT as { claude_code: boolean }).claude_code = false;
    try {
      await takeAndUndo();
    } finally {
      (LOGIN_PER_AGENT as { claude_code: boolean }).claude_code = was;
    }
  });
  async function takeAndUndo() {
    const mine = account({ id: "acct_mine", label: "Claude Pro", usedBy: ["Ada"], usedByIds: [ADA_ID] });
    const atlas = account({
      id: "acct_atlas",
      label: "Claude Max",
      email: "atlas@acme.com",
      usedBy: ["Atlas"],
      usedByIds: [ATLAS_ID],
    });
    const { state, api } = await ada({ account: "acct_mine", accounts: [mine, atlas] });
    // Atlas's AI before the move: its login and its own model.
    const read = api.agents.brain;
    api.agents.brain = async (orgId, agentId, scope) =>
      agentId === ATLAS_ID
        ? fakeAgentBrain(ATLAS_ID, { brain: "claude_code", account: "acct_atlas", model: "opus" })
        : read(orgId, agentId, scope);
    const d = await brainDialog("Quem pensa pela Ada");
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "atlas@acme.com");
    // It asks first, then moves the login here.
    expect(shownText(d)).toContain("Atlas deixa de usar esta conta.");
    await click(within(d).getByRole("button", { name: /^Trocar para/ }));
    await settle(6);
    const calls = () => state.calls.filter((c) => c.method === "agents.setBrain").map((c) => [c.args[1], c.args[2]]);
    expect(calls()).toEqual([[ADA_ID, expect.objectContaining({ account: "acct_atlas", moveAccount: true })]]);
    expect(brainScreen(d)).toBe("Pronto");
    expect(shownText(d)).toContain("Atlas deixou de usar esta conta. Desfazer devolve a conta.");
    await click(within(d).getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(calls().slice(1)).toEqual([
      [ADA_ID, expect.objectContaining({ account: "acct_mine" })],
      [ATLAS_ID, { brain: "claude_code", account: "acct_atlas", model: "opus" }],
    ]);
  }
});
