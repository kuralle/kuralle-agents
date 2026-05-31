/**
 * clean-doctors.ts
 * 
 * Preprocesses the raw "Doctor List.json" into a clean, flat "doctors.json"
 * that the chatbot can load at runtime.
 * 
 * Steps:
 *   1. Filter out non-doctor entries (services, MR/MISS/MRS prefixed staff)
 *   2. Deduplicate by slmcId (real doctor identifier), merging specializations
 *   3. Normalize names to title case (e.g. "DR AMILA WALAWWATTA" → "Dr. Amila Walawwatta")
 *   4. Deduplicate specializations per doctor
 *   5. Generate random consultation fees (LKR 1000–5000, in 500 increments)
 *   6. Generate random availability strings from a fixed timeslot pool
 *   7. Write output to ../data/doctors.json
 * 
 * Usage:
 *   bun run scripts/clean-doctors.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

interface RawDoctor {
    doctorName: string;
    doctorID: string;
    gender: string;
    slmcId: string;
    isTele: number;
    hospitals: Array<{
        hospitalId: string;
        hospital: string;
        address: { city: string };
    }>;
    specializations: Array<{
        specialization: string;
        specializationId: string;
    }>;
}

interface CleanDoctor {
    id: string;
    name: string;
    gender: string;
    specializations: string[];
    consultationFee: string;
    availability: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Seed-based pseudo-random so results are stable across runs */
function seededRandom(seed: number) {
    let s = seed;
    return () => {
        s = (s * 16807 + 0) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

const rand = seededRandom(42);

/** Title-case a string: "DR AMILA WALAWWATTA" → "Dr. Amila Walawwatta" */
function titleCase(name: string): string {
    return name
        .toLowerCase()
        .split(/\s+/)
        .map((word, i) => {
            if (i === 0 && word === 'dr') return 'Dr.';
            if (i === 0 && word === 'dr.') return 'Dr.';
            // Handle initials like "a.k." or "a.d.t.m.s."
            if (/^[a-z]\./.test(word)) return word.toUpperCase();
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ');
}

/** Normalize a specialization string */
function normalizeSpec(spec: string): string {
    return spec
        .split(/\s+/)
        .map(w => {
            const lower = w.toLowerCase();
            // Keep small connector words lowercase
            if (['and', 'in', 'of', 'the'].includes(lower)) return lower;
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join(' ');
}

/** Generate a random consultation fee between 1000-5000 in 500 increments */
function randomFee(): string {
    const steps = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
    const fee = steps[Math.floor(rand() * steps.length)];
    return `LKR ${fee.toLocaleString()}`;
}

// Fixed pool of realistic availability slots
const AVAILABILITY_POOL = [
    'Mon, Wed, Fri – 6:00 PM to 9:00 PM',
    'Mon–Fri – 3:00 PM to 6:00 PM',
    'Tue, Thu – 6:00 PM to 9:00 PM',
    'Tue & Thu – 4:00 PM to 7:00 PM',
    'Sat – 10:00 AM to 1:00 PM',
    'Mon & Thu – 4:30 PM to 7:30 PM',
    'Mon & Wed – 5:00 PM to 8:00 PM',
    'Wed & Fri – 5:00 PM to 8:00 PM',
    'Thu & Sat – 10:00 AM to 2:00 PM',
    'Mon–Sat – 10:00 AM to 1:00 PM',
    'Tue – 4:00 PM to 7:00 PM | Sat – 8:00 AM to 11:00 AM',
    'Wed – 3:00 PM to 6:00 PM',
    'Tue & Fri – 6:00 PM to 9:00 PM',
    'Mon–Fri – 5:00 PM to 8:00 PM',
    'Mon & Thu – 9:00 AM to 1:00 PM',
    'Wed & Sat – 4:00 PM to 7:00 PM',
    'Mon–Fri – 9:00 AM to 4:00 PM',
    'Mon–Sat – 8:30 AM to 12:30 PM',
    'Mon & Wed – 9:00 AM to 12:00 PM',
    'Tue, Thu, Sat – 3:00 PM to 6:00 PM',
];

function randomAvailability(): string {
    return AVAILABILITY_POOL[Math.floor(rand() * AVAILABILITY_POOL.length)];
}

// ── Main ───────────────────────────────────────────────────────────────────

const scriptDir = dirname(new URL(import.meta.url).pathname);
const rawPath = join(scriptDir, '..', 'Doctor List.json');
const outDir = join(scriptDir, '..', 'data');
const outPath = join(outDir, 'doctors.json');

console.log('📖 Reading raw doctor list…');
const raw: RawDoctor[] = JSON.parse(readFileSync(rawPath, 'utf-8'));
console.log(`   ${raw.length} entries found`);

// Step 1: Filter out non-doctor entries
const VALID_PREFIXES = ['DR ', 'DR.'];
const doctorEntries = raw.filter(d => {
    const name = d.doctorName.trim().toUpperCase();
    return VALID_PREFIXES.some(p => name.startsWith(p));
});
console.log(`   ${doctorEntries.length} doctor entries after filtering (dropped ${raw.length - doctorEntries.length} non-doctor entries)`);

// Step 2: Deduplicate by slmcId, merging specializations
const bySlmcId = new Map<string, { entry: RawDoctor; specs: Set<string> }>();

for (const entry of doctorEntries) {
    const key = entry.slmcId;
    const existing = bySlmcId.get(key);

    if (existing) {
        // Merge specializations
        for (const s of entry.specializations) {
            existing.specs.add(s.specialization);
        }
    } else {
        const specs = new Set(entry.specializations.map(s => s.specialization));
        bySlmcId.set(key, { entry, specs });
    }
}
console.log(`   ${bySlmcId.size} unique doctors after deduplication`);

// Step 3-6: Build clean output
const cleanDoctors: CleanDoctor[] = [];

for (const [, { entry, specs }] of bySlmcId) {
    const cleanSpecs = [...specs].map(normalizeSpec);

    cleanDoctors.push({
        id: entry.doctorID,
        name: titleCase(entry.doctorName.trim()),
        gender: entry.gender === 'F' ? 'Female' : entry.gender === 'M' ? 'Male' : 'N/A',
        specializations: cleanSpecs,
        consultationFee: randomFee(),
        availability: randomAvailability(),
    });
}

// Sort by name for nice output
cleanDoctors.sort((a, b) => a.name.localeCompare(b.name));

// Step 7: Write output
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(cleanDoctors, null, 2), 'utf-8');

console.log(`\n✅ Wrote ${cleanDoctors.length} clean doctor records to ${outPath}`);

// Print some stats
const allSpecs = new Set(cleanDoctors.flatMap(d => d.specializations));
console.log(`   ${allSpecs.size} unique specializations`);
console.log(`\nSample output (first 3):`);
for (const d of cleanDoctors.slice(0, 3)) {
    console.log(`   ${d.name} — ${d.specializations.join(', ')} — ${d.consultationFee} — ${d.availability}`);
}
