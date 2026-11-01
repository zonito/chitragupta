import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Receipts } from "@/routes/receipts";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider, useDocuments } from "@/components/documents";
import { hydrateData, type Doc } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * The client side of real documents: the Receipts drop zone files via
 * POST /api/documents with the file's bytes, Activity's attach uploads
 * with the transaction's own details, detach calls the detach endpoint,
 * and the provider resyncs from a reloaded snapshot.
 */

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Receipts save flow", () => {
  it("POSTs the file bytes with the filing form details and lists the saved document", async () => {
    const created: Doc = {
      id: "doc-penny-new",
      merchant: "Penny Caulfield",
      date: "9 Oct 2026",
      amount: 148,
      type: "Receipt",
      path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-09_PennyCaulfield_£148.00.pdf",
    };
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) =>
      jsonResponse({ ok: true, document: created }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <PersonProvider>
        <DocumentsProvider>
          <Receipts />
        </DocumentsProvider>
      </PersonProvider>,
    );

    const fileInput = container.querySelector('input[type="file"]')!;
    const file = new File(["pdf-bytes"], "penny.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // The form arrives pre-filled with type Receipt and a date.
    const typeSelect = screen.getByLabelText(
      "Document type",
    ) as HTMLSelectElement;
    expect(typeSelect.value).toBe("Receipt");
    const dateInput = screen.getByLabelText(
      "Document date",
    ) as HTMLInputElement;
    expect(dateInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    fireEvent.change(screen.getByLabelText("Merchant"), {
      target: { value: "Penny Caulfield" },
    });
    fireEvent.change(dateInput, { target: { value: "2026-10-09" } });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "148" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/documents");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload["filename"]).toBe("penny.pdf");
    expect(payload["contentBase64"]).toBe(
      Buffer.from("pdf-bytes").toString("base64"),
    );
    expect(payload["type"]).toBe("Receipt");
    expect(payload["merchant"]).toBe("Penny Caulfield");
    expect(payload["date"]).toBe("2026-10-09");
    expect(payload["amount"]).toBe(148);

    // The persisted document appears in the list without a reload.
    expect(await screen.findByText("Penny Caulfield")).toBeTruthy();
  });

  it("previews a filed PDF through the file endpoint, not a placeholder", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(
      <PersonProvider>
        <DocumentsProvider>
          <Receipts />
        </DocumentsProvider>
      </PersonProvider>,
    );
    fireEvent.click(screen.getByText("Ikea"));
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("/api/documents/d1/file");
    expect(screen.getByRole("link", { name: "Open document" })).toBeTruthy();
    expect(screen.queryByText("Document preview")).toBeNull();
  });
});

describe("Activity attach and detach", () => {
  it("uploads the chosen file with the transaction's merchant, date, amount and fingerprint", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const payload = JSON.parse(init?.body ?? "{}") as {
        merchant: string;
        date: string;
        amount: number;
        txnId: string;
      };
      const doc: Doc = {
        id: "doc-attached",
        merchant: payload.merchant,
        date: "29 Oct 2026",
        amount: payload.amount,
        type: "Receipt",
        txnId: payload.txnId,
        path: `PersonalFinance/Documents/Receipts/2026/2026-10/${payload.date}_Ocado_£${payload.amount.toFixed(2)}.pdf`,
      };
      return jsonResponse({ ok: true, document: doc });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );

    fireEvent.click(screen.getAllByText("Ocado")[0]!);
    expect(await screen.findByText("Add receipt")).toBeTruthy();
    const file = new File(["receipt-bytes"], "ocado.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByLabelText("Receipt file"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/documents");
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload["filename"]).toBe("ocado.pdf");
    expect(payload["contentBase64"]).toBe(
      Buffer.from("receipt-bytes").toString("base64"),
    );
    expect(payload["merchant"]).toBe("Ocado");
    expect(payload["date"]).toBe("2026-10-29");
    expect(payload["amount"]).toBe(89.3);
    expect(payload["txnId"]).toBe("48");

    // The paperclip state is the persisted record: its filename shows.
    expect(await screen.findByText("2026-10-29_Ocado_£89.30.pdf")).toBeTruthy();
  });

  it("detaches through the detach endpoint and the receipt returns to Add", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, detached: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );

    fireEvent.click(screen.getByText("John Lewis"));
    expect(
      await screen.findByText("2026-10-11_JohnLewis_£64.00.pdf"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/documents/detach");
    expect(JSON.parse(init.body)).toEqual({ txnId: "21" });
    expect(await screen.findByText("Add receipt")).toBeTruthy();
  });
});

describe("DocumentsProvider resync", () => {
  function Probe() {
    const { documents } = useDocuments();
    return (
      <ul>
        {documents.map((d) => (
          <li key={d.id}>{d.id}</li>
        ))}
      </ul>
    );
  }

  it("adopts a changed snapshot's documents on rerender", () => {
    const { rerender } = render(
      <DocumentsProvider>
        <Probe />
      </DocumentsProvider>,
    );
    expect(screen.getByText("d1")).toBeTruthy();
    expect(screen.getByText("d6")).toBeTruthy();

    const only: Doc = {
      id: "only-doc",
      merchant: "Solo",
      date: "1 Oct 2026",
      amount: 5,
      type: "Receipt",
      path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-01_Solo_£5.00.pdf",
    };
    act(() => {
      hydrateData({ ...SAMPLE_SNAPSHOT, docs: [only] });
    });
    // A fresh element: rerendering the identical element object would
    // let React bail out without ever re-reading the snapshot.
    rerender(
      <DocumentsProvider>
        <Probe />
      </DocumentsProvider>,
    );
    expect(screen.getByText("only-doc")).toBeTruthy();
    expect(screen.queryByText("d1")).toBeNull();
  });
});
