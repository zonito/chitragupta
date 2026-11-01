import type { CardItem } from "./data";

/**
 * The Cards register's stored shape. The register is localStorage by
 * design (statements carry no card data), stored under one key as a
 * JSON array. The v1 shape was a plain CardItem[] — two cards sharing
 * a last-4 collided as React list keys, and there was no stable way to
 * delete one specific card. The stored shape now carries a unique id
 * per card; v1 entries are migrated on restore by being given one.
 */
export interface StoredCard extends CardItem {
  id: string;
}

let fallbackCounter = 0;

export function newCardId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `card-${uuid}`;
  fallbackCounter += 1;
  return `card-${Date.now()}-${fallbackCounter}`;
}

function isCardLike(value: unknown): value is CardItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["label"] === "string" &&
    typeof v["last4"] === "string" &&
    typeof v["account"] === "string" &&
    typeof v["issued"] === "string" &&
    (v["owner"] === "zonito" ||
      v["owner"] === "nikhila" ||
      v["owner"] === "joint") &&
    (v["type"] === "Virtual" || v["type"] === "Physical") &&
    (v["status"] === "Active" ||
      v["status"] === "Frozen" ||
      v["status"] === "Replaced")
  );
}

/**
 * Validate and migrate a parsed stored register: v1 entries (no id)
 * gain a deterministic unique id from their position, entries that
 * already carry an id keep it, and anything that is not a card is
 * dropped rather than crashing the register.
 */
export function migrateStoredCards(raw: unknown): StoredCard[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const cards: StoredCard[] = [];
  raw.forEach((entry, index) => {
    if (!isCardLike(entry)) return;
    const existing = (entry as StoredCard).id;
    let id =
      typeof existing === "string" && existing
        ? existing
        : `card-migrated-${index}`;
    while (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    cards.push({ ...entry, id });
  });
  return cards;
}
