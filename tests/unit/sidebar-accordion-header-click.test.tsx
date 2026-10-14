// @vitest-environment jsdom
// Regression for UX-1: sidebar accordion header must expand on mouse click.
// The header was a <div role="button"> with an onClick but no tabIndex/key
// handling, so clicks produced no visible delta while Enter worked — the
// accordion was only operable via keyboard. The fix replaced it with a native
// <button>. This test pins the click path AND guards the keyboard path from
// regressing, plus the pin button isolation (clicking pin must NOT toggle the
// section — it is a sibling button with its own stopPropagation).
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_OMNIROUTE_E2E_MODE = "1";

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const translate = (key: string) => key;
    translate.has = () => false;
    return translate;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/home",
}));

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function renderSidebar() {
  const { default: Sidebar } = await import("@/shared/components/Sidebar");
  await act(async () => {
    root = createRoot(container);
    root.render(<Sidebar />);
  });
}

function collapsedHeader(): HTMLButtonElement {
  // OmniProxy is pinned-by-default (starts expanded); the other sections start
  // collapsed. Target a collapsed header so the click-to-expand assertion is
  // meaningful rather than a no-op toggle of an already-expanded section.
  const collapsed = container.querySelector<HTMLButtonElement>(
    'button[aria-expanded="false"]'
  );
  if (!collapsed) throw new Error("no collapsed accordion header found");
  return collapsed;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("Sidebar accordion header click (UX-1)", () => {
  it("expands the section on a real mouse click", async () => {
    await renderSidebar();
    const header = collapsedHeader();
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await click(header);

    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("still expands via keyboard activation (Enter path must not regress)", async () => {
    await renderSidebar();
    const header = collapsedHeader();

    // A native <button> is focusable and Enter dispatches a click — the exact
    // path the ticket reported as the ONLY working one before the fix.
    header.focus();
    expect(document.activeElement).toBe(header);
    await click(header);

    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses on a second click (toggle is symmetric)", async () => {
    await renderSidebar();
    const header = collapsedHeader();

    await click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking the pin button does NOT toggle the section", async () => {
    await renderSidebar();
    const header = collapsedHeader();
    const pin = container.querySelector<HTMLButtonElement>("button[title]");
    if (!pin) throw new Error("pin button not found");

    await click(pin);

    // pin click must be isolated from the section toggle
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });
});
