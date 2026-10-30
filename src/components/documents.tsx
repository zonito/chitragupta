import { createContext, useContext, useState, type ReactNode } from "react";
import { DOCS, attachReceipt, detachReceipt, receiptForTransaction, type Doc, type Txn } from "@/lib/data";

type DocumentsState = {
  documents: Doc[];
  attach: (txn: Txn, extension?: "pdf" | "jpg" | "png") => void;
  remove: (txnId: string) => void;
};
const DocumentsContext = createContext<DocumentsState | null>(null);

export function DocumentsProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState<Doc[]>(DOCS);
  const attach = (txn: Txn, extension: "pdf" | "jpg" | "png" = "pdf") =>
    setDocuments((current) => attachReceipt(current, receiptForTransaction(txn, extension)));
  const remove = (txnId: string) => setDocuments((current) => detachReceipt(current, txnId));
  return <DocumentsContext.Provider value={{ documents, attach, remove }}>{children}</DocumentsContext.Provider>;
}

export function useDocuments() {
  const state = useContext(DocumentsContext);
  if (!state) throw new Error("DocumentsProvider is required");
  return state;
}