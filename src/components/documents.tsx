import { createContext, useContext, useState, type ReactNode } from "react";
import {
  DOCS,
  attachReceipt,
  detachReceipt,
  getSnapshot,
  type Doc,
  type DocType,
  type Txn,
} from "@/lib/data";
import { fileToBase64 } from "@/lib/file-base64";

export interface DocumentUploadInput {
  file: File;
  type: DocType;
  merchant: string;
  date: string; // ISO YYYY-MM-DD
  amount: number; // pounds
  txnId?: string;
  warrantyEnds?: string;
}

type DocumentsState = {
  documents: Doc[];
  /** Upload a file as a document, filed by the server under the data
   *  dir's Documents tree and recorded in the store. */
  upload: (input: DocumentUploadInput) => Promise<Doc>;
  /** Attach a file to a transaction (a Receipt in the transaction's
   *  own merchant, date and amount). */
  attach: (txn: Txn, file: File) => Promise<Doc>;
  /** Detach the document linked to a transaction; it stays filed,
   *  listed as unmatched. */
  remove: (txnId: string) => Promise<void>;
  /** Re-read the documents from the hydrated snapshot. */
  resync: () => void;
};
const DocumentsContext = createContext<DocumentsState | null>(null);

async function postDocument(input: DocumentUploadInput): Promise<Doc> {
  const contentBase64 = await fileToBase64(input.file);
  const res = await fetch("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: input.file.name,
      contentBase64,
      type: input.type,
      merchant: input.merchant,
      date: input.date,
      amount: input.amount,
      ...(input.txnId ? { txnId: input.txnId } : {}),
      ...(input.warrantyEnds ? { warrantyEnds: input.warrantyEnds } : {}),
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    document?: Doc;
    error?: string;
  } | null;
  if (!res.ok || !body?.ok || !body.document) {
    throw new Error(body?.error ?? "Upload failed");
  }
  return body.document;
}

export function DocumentsProvider({ children }: { children: ReactNode }) {
  const snapshot = getSnapshot();
  const [documents, setDocuments] = useState<Doc[]>(() => [...DOCS]);
  // The persisted set is the snapshot's docs. When a snapshot reload
  // lands (hydrateData in the root loader, e.g. after router.invalidate
  // following a mutation), adopt it during render so Activity, Receipts
  // and Ask — all reading this provider — stay synchronised.
  const [syncedSnapshot, setSyncedSnapshot] = useState(snapshot);
  if (syncedSnapshot !== snapshot) {
    setSyncedSnapshot(snapshot);
    setDocuments([...snapshot.docs]);
  }
  const resync = () => setDocuments([...getSnapshot().docs]);
  const upload = async (input: DocumentUploadInput): Promise<Doc> => {
    const doc = await postDocument(input);
    setDocuments((current) => {
      // A transaction keeps one linked document: the previous link is
      // detached (retained, unmatched), mirroring the server.
      const base = input.txnId ? detachReceipt(current, input.txnId) : current;
      return attachReceipt(base, doc);
    });
    return doc;
  };
  const attach = (txn: Txn, file: File): Promise<Doc> =>
    upload({
      file,
      type: "Receipt",
      merchant: txn.merchant,
      date: txn.date,
      amount: txn.amount,
      txnId: txn.id,
    });
  const remove = async (txnId: string): Promise<void> => {
    const res = await fetch("/api/documents/detach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txnId }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error ?? "Detach failed");
    }
    setDocuments((current) => detachReceipt(current, txnId));
  };
  return (
    <DocumentsContext.Provider
      value={{ documents, attach, upload, remove, resync }}
    >
      {children}
    </DocumentsContext.Provider>
  );
}

export function useDocuments() {
  const state = useContext(DocumentsContext);
  if (!state) throw new Error("DocumentsProvider is required");
  return state;
}

/** The real filed file, via the documents file endpoint: an image for
 *  photos, an embedded viewer plus an open link for PDFs. */
export function DocumentPreview({ doc }: { doc: Doc }) {
  const src = `/api/documents/${doc.id}/file`;
  const ext = doc.path.split(".").at(-1)?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg" || ext === "png") {
    return (
      <img
        src={src}
        alt={`Document for ${doc.merchant}`}
        className="max-h-72 w-full rounded-xl border bg-muted object-contain"
      />
    );
  }
  if (ext === "pdf") {
    return (
      <div>
        <iframe
          src={src}
          title={`Document for ${doc.merchant}`}
          className="h-72 w-full rounded-xl border bg-muted"
        />
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-caption text-primary underline"
        >
          Open document
        </a>
      </div>
    );
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="inline-block text-body text-primary underline"
    >
      Open document
    </a>
  );
}
