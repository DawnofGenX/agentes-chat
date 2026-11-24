import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, AiAccounts, AiComputer } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { brainDialog } from "./ai-picker";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { openOrder } from "./plan-rows";
import { renderApp, screen, settle } from "./render";

/*
 * The one "Quem pensa" picker (Conta, Modelo, Esforço) and Contas de IA's account detail: one row per account in the
 * picker's groups, the ones that can't think here dimmed with why, each change saved at once; an account's three
 * permissions; the order of use's API-key switch.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
/** A select opened by its keys: its options. */
async function options(combobox: HTMLElement) {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await settle(3);
  return screen().getAllByRole("option");
}
const name = (o: Element) => o.querySelector(".aa-opt__name")?.textContent ?? o.textContent ?? "";

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};
type Row = AiAccounts["accounts"][number];
const account = (id: string, label: string, over: Partial<Row> = {}): Row => ({
  id,
  kind: "claude_code",
  label,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  shared: true,
  named: true,
  machineId: "machine_1",
  computer: "MacBook",
  ...over,
});
const WORK = account("acct_work", "Trabalho");
const JOAO = account("acct_joao", "Claude do João", { ownerId: "u-joao", ownerName: "João Silva", mine: false });
const MARINA = account("acct_marina", "Pessoal da Marina", {
  ownerId: "u-marina",
  ownerName: "Marina Ribeiro",
  mine: false,
  serves: "owner",
});

async function agentPage(accounts: Row[], others = false, patch: Partial<AgentBrain> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers: [MAC] });
  fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook" });
  api.agents.brain = async (_org, id) =>
    fakeAgentBrain(id, {
      brain: "claude_code",
      account: "acct_work",
      effort: "medium",
      accounts: accounts.map((a) => ({ ...a, usable: a.mine || a.serves !== "owner" })),
      computer: { machineId: "machine_1", name: "MacBook", online: true },
      canUsePlans: true,
      canEdit: true,
      ...(others ? { canUseOthersPlans: true } : {}),
      ...patch,
    });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api };
}

describe("Quem pensa: the one picker", () => {
  test("Conta lists the viewer's, then the team's, then the workspace's keys; one only its owner uses is dimmed, saying so", async () => {
    await agentPage([WORK, JOAO, MARINA]);
    const d = await brainDialog();
    const conta = within(d).getByRole("combobox", { name: "Conta" });
    // Closed: the account in use by its name and plan, one line.
    expect(conta.querySelector(".aa-opt__name")?.textContent).toBe("Trabalho");
    expect(conta.querySelector(".aa-meta__plan")?.textContent).toBe("Max");
    const rows = await options(conta);
    expect(rows.map(name)).toEqual(["Trabalho", "Claude do João", "Pessoal da Marina", "Claude da Acme"]);
    expect(
      [...screen().getAllByRole("group")]
        .filter((g) => g.closest(".ac-tz__list"))
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Suas", "Do time", "Do workspace"]);
    const marina = rows[2] as HTMLElement;
    expect(marina.getAttribute("aria-disabled")).toBe("true");
    expect(marina.querySelector(".aa-room")?.textContent).toBe("Só Marina usa");
    expect(rows[1]?.querySelector(".aa-meta__plan")?.textContent).toBe("Max · de João");
    // The one in use: its plate and heavier name, no check column.
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".ac-tz__check")).toBeNull();
  });

  test("the search finds an account by its owner's name; no match says so", async () => {
    await agentPage([WORK, JOAO, MARINA]);
    const d = await brainDialog();
    await options(within(d).getByRole("combobox", { name: "Conta" }));
    const search = screen().getByRole("combobox", { name: "Buscar por nome, IA, plano ou dono" });
    await act(async () => fireEvent.change(search, { target: { value: "joão" } }));
    await settle(2);
    expect(screen().getAllByRole("option").map(name)).toEqual(["Claude do João"]);
    await act(async () => fireEvent.change(search, { target: { value: "ninguém" } }));
    await settle(2);
    expect(screen().queryAllByRole("option")).toHaveLength(0);
    expect(screen().getByText("Nenhuma conta encontrada.")).toBeTruthy();
  });

  test("Modelo and Esforço side by side, each saved as it is picked; Automático picks the effort too", async () => {
    const { state } = await agentPage([WORK]);
    const d = await brainDialog();
    const pair = d.querySelector(".aa-pair") as HTMLElement;
    expect(
      within(pair)
        .getAllByRole("combobox")
        .map((c) => c.getAttribute("aria-labelledby") !== null),
    ).toHaveLength(2);
    const opus = (await options(within(pair).getByRole("combobox", { name: "Modelo" }))).find((o) =>
      /^Opus/.test(o.textContent ?? ""),
    );
    await click(opus as Element);
    await settle(6);
    const sent = state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
    expect(sent.at(-1)).toMatchObject({ brain: "claude_code", account: "acct_work", model: "opus" });
    const auto = (await options(within(pair).getByRole("combobox", { name: "Modelo" }))).find(
      (o) => o.textContent === "Automático",
    );
    await click(auto as Element);
    await settle(6);
    expect(
      state.calls
        .filter((c) => c.method === "agents.setBrain")
        .map((c) => c.args[2])
        .at(-1),
    ).toMatchObject({ model: "auto", effort: "auto" });
  });

  test("Esforço offers the levels the model's catalog row lists; a pick saves at once and Desfazer puts back the one before", async () => {
    const { state } = await agentPage([WORK]);
    const d = await brainDialog();
    const effort = within(d.querySelector(".aa-pair") as HTMLElement).getByRole("combobox", { name: "Esforço" });
    // Sonnet 5.5, the plan's default: every level Claude's API takes, Muito alto included.
    const levels = await options(effort);
    expect(levels.map((o) => o.textContent)).toEqual(["Baixo", "Médio", "Alto", "Muito alto", "Máximo"]);
    await click(levels.find((o) => o.textContent === "Muito alto") as Element);
    await settle(6);
    const sent = () => state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
    expect(sent().at(-1)).toMatchObject({ brain: "claude_code", effort: "xhigh" });
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(sent().at(-1)).toMatchObject({ brain: "claude_code", account: "acct_work", effort: "medium" });
  });

  test("a stored level the model doesn't take shows as the one it runs at, and picking that one saves it", async () => {
    const codex = account("acct_work", "Trabalho", { kind: "codex", plan: "pro" });
    const { state } = await agentPage([codex], false, { brain: "codex", effort: "max" });
    const d = await brainDialog();
    const effort = within(d.querySelector(".aa-pair") as HTMLElement).getByRole("combobox", { name: "Esforço" });
    expect(effort.textContent).toContain("Alto");
    const levels = await options(effort);
    expect(levels.map((o) => o.textContent)).toEqual(["Baixo", "Médio", "Alto"]);
    await click(levels.find((o) => o.textContent === "Alto") as Element);
    await settle(6);
    const sent = state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
    expect(sent.at(-1)).toMatchObject({ brain: "codex", effort: "high" });
  });

  test("someone else's plan asks first, in one line under Conta with one button; nothing saves until it is pressed", async () => {
    const BIA = account("acct_bia", "Max da Bia", { ownerId: "u-bia", ownerName: "Bia Souza", mine: false });
    const { state } = await agentPage([WORK, BIA], true);
    const d = await brainDialog();
    const rows = await options(within(d).getByRole("combobox", { name: "Conta" }));
    await click(rows.find((o) => name(o) === "Max da Bia") as Element);
    await settle(4);
    expect(state.calls.some((c) => c.method === "agents.setBrain")).toBe(false);
    const line = d.querySelector(".ac-setnote-line") as HTMLElement;
    expect(line.textContent).toContain("Bia recebe um aviso por e-mail.");
    // No footer pair to confirm with: the line's one button.
    expect(within(d).queryByRole("button", { name: "Cancelar" })).toBeNull();
    await click(within(line).getByRole("button", { name: "Trocar para Max da Bia" }));
    await settle(6);
    expect(
      state.calls
        .filter((c) => c.method === "agents.setBrain")
        .map((c) => c.args[2])
        .at(-1),
    ).toMatchObject({ brain: "claude_code", account: "acct_bia" });
  });

  test("a long name ends in an ellipsis on one line, whole in its tooltip", async () => {
    const long = account("acct_long", "Conta compartilhada do time de engenharia de dados e plataforma", {
      ownerName: "Maria Fernanda Albuquerque Cavalcanti",
      ownerId: "u-maria",
      mine: false,
    });
    await agentPage([WORK, long]);
    const d = await brainDialog();
    const rows = await options(within(d).getByRole("combobox", { name: "Conta" }));
    const row = rows.find((o) => name(o).startsWith("Conta compartilhada")) as HTMLElement;
    expect(row.querySelector(".aa-opt__name")?.getAttribute("title")).toBe(
      "Conta compartilhada do time de engenharia de dados e plataforma",
    );
    expect(row.querySelector(".aa-meta__plan")?.getAttribute("title")).toBe("Max · de Maria");
  });
});

describe("Contas de IA: an account's permissions and the order's switch", () => {
  async function hub(accounts: Row[]) {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers: [MAC] });
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
    await settle(6);
    return { state, api };
  }
  const open = async (title: string) => {
    const row = [...document.querySelectorAll(".aa-list .plan-row")].find(
      (r) => r.querySelector(".plan-row__title")?.textContent === title,
    );
    await click(row?.querySelector(".plan-row__head") as Element);
    return screen().getByRole("dialog", { name: title });
  };

  test("its limits, then Gerenciar, Usar em agentes and Atender todos, each with its line, ⓘ and choice", async () => {
    await hub([WORK, JOAO]);
    const d = await open("Trabalho");
    expect(within(d).getByRole("heading", { name: "Limites" })).toBeTruthy();
    expect(within(d).getByRole("heading", { name: "Permissões" })).toBeTruthy();
    const choices = ["Gerenciar", "Usar em agentes", "Atender todos"].map((n) =>
      within(d).getByRole("combobox", { name: n }),
    );
    expect(choices.map((c) => c.textContent)).toEqual(["Você e administradores", "Todos", "Só o dono do agente"]);
    expect(choices.map((c) => c.hasAttribute("disabled"))).toEqual([false, false, false]);
    for (const n of ["Gerenciar", "Usar em agentes", "Atender todos"])
      expect(within(d).getByRole("button", { name: `Sobre ${n}` })).toBeTruthy();
    expect(d.textContent).toContain("Renomear, entrar de novo, excluir");
    // Someone else's: in sight, nothing to change.
    await click(within(d).getByRole("button", { name: "Fechar" }));
    const his = await open("Claude do João");
    expect(
      ["Gerenciar", "Usar em agentes", "Atender todos"].map((n) =>
        within(his).getByRole("combobox", { name: n }).hasAttribute("disabled"),
      ),
    ).toEqual([true, true, true]);
    expect(within(his).getByRole("combobox", { name: "Gerenciar" }).textContent).toBe("João e administradores");
  });

  test("Pessoas… asks whom, and saves those people", async () => {
    const { state } = await hub([WORK]);
    const d = await open("Trabalho");
    const use = within(d).getByRole("combobox", { name: "Usar em agentes" });
    await click((await options(use)).find((o) => o.textContent === "Pessoas…") as Element);
    const pick = screen().getByRole("dialog", { name: "Usar em agentes" });
    const boxes = within(pick).getAllByRole("checkbox");
    await click(boxes[0] as Element);
    await click(within(pick).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const saved = state.calls.find((c) => c.method === "machines.setAccountPermissions")?.args;
    expect(saved?.[1]).toBe("acct_work");
    expect(saved?.[2]).toMatchObject({ use: { mode: "people", roleIds: [] } });
    expect((saved?.[2] as { use: { userIds: string[] } } | undefined)?.use.userIds).toHaveLength(1);
  });

  test("Ordem de uso: the API-key switch is off by default and saves at once", async () => {
    const { state } = await hub([WORK, account("acct_two", "Reserva", { useOrder: 1 })]);
    const order = await openOrder();
    const fallback = within(order).getByRole("switch", {
      name: "Continuar com a chave de API quando todos os planos estiverem no limite",
    });
    expect(fallback.getAttribute("aria-checked")).toBe("false");
    await click(fallback);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.setKeyFallback").map((c) => c.args[1])).toEqual([true]);
  });
});

test("the DM header's picker: a login Atlas thinks with asks first; Desfazer puts Ada back and gives it back to Atlas", async () => {
  const atlas = account("acct_atlas", "Max do Atlas", { shared: false, usedBy: ["Atlas"], usedByIds: [ATLAS_ID] });
  const state = seedState();
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [WORK, atlas], computers: [MAC] });
  fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook" });
  api.agents.brain = async (_org, id) =>
    fakeAgentBrain(id, {
      brain: "claude_code",
      account: id === ATLAS_ID ? "acct_atlas" : "acct_work",
      model: id === ATLAS_ID ? "opus" : null,
      accounts: [WORK, atlas].map((a) => ({ ...a, usable: true })),
      computer: { machineId: "machine_1", name: "MacBook", online: true },
      canUsePlans: true,
      canEdit: true,
    });
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api });
  await settle(8);
  const header = document.querySelector(".channel__header") as HTMLElement;
  await click(within(header).getByRole("button", { name: "Mudar o modelo de Ada" }));
  await settle(4);
  const d = screen().getByRole("dialog");
  const rows = await options(within(d).getByRole("combobox", { name: "Conta" }));
  await click(rows.find((o) => name(o) === "Max do Atlas") as Element);
  await settle(4);
  const line = d.querySelector(".ac-setnote-line") as HTMLElement;
  expect(line.textContent).toContain("Atlas deixa de usar esta conta.");
  // Clicked twice while Atlas's AI is read: taken once.
  const take = within(line).getByRole("button");
  act(() => void fireEvent.click(take));
  act(() => void fireEvent.click(take));
  await settle(6);
  const sent = () => state.calls.filter((c) => c.method === "agents.setBrain").map((c) => [c.args[1], c.args[2]]);
  expect(sent()).toEqual([[ADA_ID, expect.objectContaining({ account: "acct_atlas", moveAccount: true })]]);
  await click(screen().getByRole("button", { name: "Desfazer" }));
  await settle(6);
  expect(sent().slice(1)).toEqual([
    [ADA_ID, expect.objectContaining({ account: "acct_work" })],
    [ATLAS_ID, { brain: "claude_code", account: "acct_atlas", model: "opus" }],
  ]);
});
