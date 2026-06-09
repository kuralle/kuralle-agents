/**
 * Demo pharmacy inventory. Static, in-repo — a real deployment would back this with
 * a DB / catalog service. Prices are illustrative (USD).
 */
export interface InventoryItem {
  /** Canonical product id. */
  id: string;
  /** Generic / brand name. */
  name: string;
  /** Strength as dispensed (e.g. "500mg"). */
  strength: string;
  /** Units in stock. */
  stock: number;
  /** Unit price (USD). */
  price: number;
  /** Whether a prescription is required to dispense. */
  rxRequired: boolean;
}

export const INVENTORY: InventoryItem[] = [
  { id: 'amoxicillin-500', name: 'Amoxicillin', strength: '500mg', stock: 120, price: 0.45, rxRequired: true },
  { id: 'amoxicillin-250', name: 'Amoxicillin', strength: '250mg', stock: 0, price: 0.3, rxRequired: true },
  { id: 'metformin-500', name: 'Metformin', strength: '500mg', stock: 300, price: 0.12, rxRequired: true },
  { id: 'metformin-1000', name: 'Metformin', strength: '1000mg', stock: 80, price: 0.2, rxRequired: true },
  { id: 'atorvastatin-20', name: 'Atorvastatin', strength: '20mg', stock: 60, price: 0.55, rxRequired: true },
  { id: 'lisinopril-10', name: 'Lisinopril', strength: '10mg', stock: 45, price: 0.35, rxRequired: true },
  { id: 'omeprazole-20', name: 'Omeprazole', strength: '20mg', stock: 200, price: 0.25, rxRequired: false },
  { id: 'amlodipine-5', name: 'Amlodipine', strength: '5mg', stock: 0, price: 0.4, rxRequired: true },
  { id: 'azithromycin-250', name: 'Azithromycin', strength: '250mg', stock: 30, price: 1.1, rxRequired: true },
  { id: 'ibuprofen-400', name: 'Ibuprofen', strength: '400mg', stock: 500, price: 0.08, rxRequired: false },
  { id: 'paracetamol-500', name: 'Paracetamol', strength: '500mg', stock: 1000, price: 0.05, rxRequired: false },
  { id: 'cetirizine-10', name: 'Cetirizine', strength: '10mg', stock: 150, price: 0.15, rxRequired: false },
  { id: 'salbutamol-inhaler', name: 'Salbutamol Inhaler', strength: '100mcg', stock: 25, price: 6.5, rxRequired: true },
  { id: 'levothyroxine-50', name: 'Levothyroxine', strength: '50mcg', stock: 90, price: 0.3, rxRequired: true },
  { id: 'losartan-50', name: 'Losartan', strength: '50mg', stock: 70, price: 0.42, rxRequired: true },
];

export interface InventoryMatch {
  query: { name: string; strength?: string };
  matched: InventoryItem | null;
  inStock: boolean;
  alternatives: InventoryItem[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Match a requested medicine (name + optional strength) against inventory.
 * Exact strength match preferred; otherwise returns same-name alternatives so the
 * agent can offer a substitute strength.
 */
export function matchInventory(name: string, strength?: string): InventoryMatch {
  const qn = norm(name);
  const sameName = INVENTORY.filter((it) => norm(it.name).includes(qn) || qn.includes(norm(it.name)));

  let matched: InventoryItem | null = null;
  if (strength) {
    const qs = norm(strength);
    matched = sameName.find((it) => norm(it.strength) === qs) ?? null;
  }
  if (!matched && sameName.length === 1) matched = sameName[0]!;

  const inStock = !!matched && matched.stock > 0;
  const alternatives = sameName.filter((it) => it.id !== matched?.id && it.stock > 0);
  return { query: { name, strength }, matched, inStock, alternatives };
}
