import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Sheet } from "@/components/shell";

/**
 * B9b / A3 §4.1-4.2: the shared Sheet owns the height bound and the
 * dialog semantics, so every call site inherits them and no caller
 * keeps its own scroll wrapper (exactly one scrollbar).
 */

describe("Sheet", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Sheet open={false} onClose={() => {}}>
        <p>Hidden</p>
      </Sheet>,
    );
    expect(container.textContent).toBe("");
  });

  it("is a modal dialog with a bounded, scrolling panel", () => {
    render(
      <Sheet open onClose={() => {}}>
        <p>Sheet body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.className).toContain("max-h-[85vh]");
    expect(dialog.className).toContain("overflow-y-auto");
    expect(screen.getByText("Sheet body")).toBeTruthy();
  });

  it("closes from the accessible close button", () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose}>
        <p>Sheet body</p>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose}>
        <p>Sheet body</p>
      </Sheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still closes on backdrop click but not on panel click", () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose}>
        <p>Sheet body</p>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("no call site keeps its own 75vh scroll wrapper", () => {
    for (const file of ["components/shell.tsx", "routes/activity.tsx", "routes/subscriptions.tsx"]) {
      const src = readFileSync(resolve(__dirname, "..", file), "utf8");
      expect(src, file).not.toContain("max-h-[75vh]");
    }
  });
});
