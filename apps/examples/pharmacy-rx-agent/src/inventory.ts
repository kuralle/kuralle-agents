export interface InventoryItem {
  id: string;
  name: string;
  strength: string;
  form: string;
  priceLkr: number;
  stock: number;
  prescriptionRequired: boolean;
}

export const INVENTORY: readonly InventoryItem[] = [
  { id: 'amox-500-cap', name: 'Amoxicillin', strength: '500 mg', form: 'capsule', priceLkr: 42, stock: 36, prescriptionRequired: true },
  { id: 'para-500-tab', name: 'Paracetamol', strength: '500 mg', form: 'tablet', priceLkr: 8.5, stock: 120, prescriptionRequired: false },
  { id: 'met-500-tab', name: 'Metformin', strength: '500 mg', form: 'tablet', priceLkr: 18, stock: 64, prescriptionRequired: true },
  { id: 'ceti-10-tab', name: 'Cetirizine', strength: '10 mg', form: 'tablet', priceLkr: 14, stock: 48, prescriptionRequired: false },
  { id: 'salb-100-inh', name: 'Salbutamol', strength: '100 mcg', form: 'inhaler', priceLkr: 1450, stock: 8, prescriptionRequired: true },
];

export function searchInventory(query: string): InventoryItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return INVENTORY.filter((item) => {
    const haystack = `${item.name} ${item.strength} ${item.form}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function formatLkr(amount: number): string {
  return `LKR ${amount.toFixed(2)}`;
}
