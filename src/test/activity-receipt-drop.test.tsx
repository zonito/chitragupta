import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type Doc } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Part 6 of the Activity pass: the transaction sheet's Receipt
 * section accepts drag-and-drop. A drop runs the same attach flow
 * as the Add receipt button (POST /api/documents with the file's
 * bytes and the transaction id), the section shows a drag-over
 * highlight while a file hovers, and a drop elsewhere in the sheet
 * is prevented from navigating the page.
 */

function stubDocuments() {
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes("/api/documents")) {
      // Echo the request's txnId into the filed document, like the
      // server does, so the sheet's attached view can match it.
      const payload = JSON.parse(init?.body ?? "{}") as { txnId?: string };
      const created: Doc = {
        id: "doc-ocado-drop",
        merchant: "Ocado",
        date: "9 Oct 2026",
        amount: 112.4,
        type: "Receipt",
        ...(payload.txnId ? { txnId: payload.txnId } : {}),
        path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-09_Ocado_£112.40.pdf",
      };
      return new Response(JSON.stringify({ ok: true, document: created }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, transactions: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openOcadoSheet() {
  render(
    <PersonProvider>
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
  // Open the sheet from the £112.40 Ocado row.
  fireEvent.click(screen.getByText("−£112.40").closest("button")!);
  const dialog = await screen.findByRole("dialog");
  return within(dialog).getByTestId("receipt-dropzone");
}

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity receipt drag-and-drop", () => {
  it("a drop on the Receipt section attaches through the same upload as the button", async () => {
    const fetchMock = stubDocuments();
    const zone = await openOcadoSheet();

    const file = new File(["pdf-bytes"], "ocado-receipt.pdf", { type: "application/pdf" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/documents"))!;
    const [url, init] = post as unknown as [string, { method: string; body: string }];
    expect(url).toBe("/api/documents");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload["filename"]).toBe("ocado-receipt.pdf");
    expect(payload["contentBase64"]).toBe(Buffer.from("pdf-bytes").toString("base64"));
    expect(typeof payload["txnId"]).toBe("string");
    expect(payload["txnId"]).not.toBe("");
    // The attached receipt shows in the section without a reload:
    // the filed path appears and the section offers Remove.
    expect((await screen.findAllByText(/Ocado_£112\.40\.pdf/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("dragging over the section highlights it; the Add receipt button stays", async () => {
    stubDocuments();
    const zone = await openOcadoSheet();
    expect(within(zone as HTMLElement).getByRole("button", { name: /Add receipt/ })).toBeTruthy();
    expect(zone.className).not.toContain("ring-primary/60");
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(zone.className).toContain("bg-primary/10");
    expect(zone.className).toContain("ring-primary/60");
    fireEvent.dragLeave(zone, { dataTransfer: { files: [] } });
    expect(zone.className).not.toContain("ring-primary/60");
  });

  it("the button path still attaches (the drop did not replace it)", async () => {
    const fetchMock = stubDocuments();
    const zone = await openOcadoSheet();
    const file = new File(["btn-bytes"], "button.pdf", { type: "application/pdf" });
    const input = zone.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/documents"))!;
    const payload = JSON.parse((post as unknown as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(payload["filename"]).toBe("button.pdf");
    expect(typeof payload["txnId"]).toBe("string");
    expect(payload["txnId"]).not.toBe("");
  });
});
