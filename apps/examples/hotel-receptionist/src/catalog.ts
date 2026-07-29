export const ROOM_TYPES = ['king', 'queen_2beds', 'double_queen', 'suite', 'penthouse'] as const;
export const ROOM_VIEWS = ['city', 'ocean', 'garden', 'interior'] as const;
export const ROOM_EXTRAS = ['breakfast', 'valet', 'late_checkout', 'pets'] as const;
export const FOLLOWUP_KINDS = [
  'housekeeping',
  'sales_lead',
  'identity_change',
  'callback',
  'verification_help',
  'early_checkout',
  'abandoned_booking',
  'lost_and_found',
  'other',
] as const;
export const DISPUTE_CATEGORIES = [
  'minibar',
  'room_service_restaurant',
  'damage_cleaning',
  'late_checkout_fee',
  'cancellation_fee',
  'no_show',
  'double_charge_billing_error',
  'other',
] as const;

export type RoomType = (typeof ROOM_TYPES)[number];
export type RoomView = (typeof ROOM_VIEWS)[number];
export type RoomExtra = (typeof ROOM_EXTRAS)[number];

export const PRICING = {
  breakfastPerNight: 2500,
  valetPerNight: 3500,
  lateCheckout: 4000,
  petFee: 5000,
  taxRatePercent: 12,
  cancellationWindowHours: 48,
} as const;

export const TOURS = {
  half_day_city: { name: 'Half-day city highlights', pricePerPerson: 6500, maxParty: 12, pickup: '09:00 at the hotel lobby' },
  full_day_city: { name: 'Full-day city and bay', pricePerPerson: 11000, maxParty: 12, pickup: '08:30 at the hotel lobby' },
  private_city: { name: 'Private half-day tour', flatPrice: 29000, maxParty: 4, pickup: '10:00 at the hotel lobby' },
} as const;

export const SPA_SERVICES = {
  deep_tissue_massage: { name: 'Deep-tissue massage', pricePerPerson: 14000, durationMinutes: 60, maxParty: 2 },
  signature_facial: { name: 'Signature facial', pricePerPerson: 12000, durationMinutes: 50, maxParty: 2 },
  personal_training: { name: 'Personal training session', pricePerPerson: 8000, durationMinutes: 45, maxParty: 1 },
  group_yoga: { name: 'Group yoga class', pricePerPerson: 4000, durationMinutes: 60, maxParty: 8 },
} as const;

export const BUSINESS_SERVICES = {
  meeting_room: { name: 'Meeting room', pricePerHour: 4000, maxHours: 8 },
  secretarial: { name: 'Secretarial service', pricePerHour: 3500, maxHours: 4 },
  printing: { name: 'Printing and binding', flatPrice: 2500, maxHours: 1 },
} as const;

export const FLORIST_ARRANGEMENTS = {
  bouquet: { name: 'Seasonal hand-tied bouquet', price: 6500 },
  roses: { name: 'Dozen long-stem roses', price: 9500 },
  centerpiece: { name: 'Table centerpiece arrangement', price: 14000 },
} as const;

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function calculateStayTotal(nightlyRate: number, nights: number, extras: readonly RoomExtra[]) {
  const roomSubtotal = nightlyRate * nights;
  const extrasSubtotal =
    (extras.includes('breakfast') ? PRICING.breakfastPerNight * nights : 0) +
    (extras.includes('valet') ? PRICING.valetPerNight * nights : 0) +
    (extras.includes('late_checkout') ? PRICING.lateCheckout : 0) +
    (extras.includes('pets') ? PRICING.petFee : 0);
  const subtotal = roomSubtotal + extrasSubtotal;
  const taxes = Math.floor(subtotal * PRICING.taxRatePercent / 100);
  return { roomSubtotal, extrasSubtotal, subtotal, taxes, total: subtotal + taxes };
}
