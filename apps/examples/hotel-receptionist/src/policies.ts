import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const POLICY_TOPICS = [
  'accessibility',
  'business_center',
  'cancellation',
  'florist',
  'functions',
  'group_bookings',
  'guest_privacy',
  'guest_services',
  'guest_walks',
  'local_area',
  'location_and_transport',
  'payments_and_currency',
  'pets',
  'restaurant_dietary',
  'restaurant_dining',
  'restaurant_menu',
  'room_service',
  'rooms_and_amenities',
  'safe_deposit',
  'spa',
  'tours',
] as const;

export type PolicyTopic = (typeof POLICY_TOPICS)[number];

export function loadPolicies(path = resolve(import.meta.dirname, '../policies/handbook.md')) {
  const source = readFileSync(path, 'utf8');
  const entries = [...source.matchAll(/^## ([a-z_]+)\n\n([\s\S]*?)(?=\n## |$)/gm)]
    .map((match) => [match[1]!, match[2]!.trim()] as const);
  const policies = Object.fromEntries(entries) as Partial<Record<PolicyTopic, string>>;
  const missing = POLICY_TOPICS.filter((topic) => !policies[topic]);
  if (missing.length > 0) throw new Error(`Hotel handbook is missing policy sections: ${missing.join(', ')}`);
  return policies as Record<PolicyTopic, string>;
}
