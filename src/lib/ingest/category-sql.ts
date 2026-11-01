/**
 * The resolved-category SQL expression, shared by every query that
 * resolves a transaction's category: explicit transaction category
 * (user override or Muse classification) → merchant memory →
 * movement fallback. One definition, so the API, Ask and the
 * aggregate recompute can never drift apart.
 */
export const CATEGORY_SQL = `COALESCE(t.category, m.category,
  CASE t.movement
    WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
    WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
    WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;
