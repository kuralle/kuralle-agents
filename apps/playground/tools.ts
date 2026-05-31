import { createTool } from '@kuralle-agents/core';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// --- Load Doctor Data from preprocessed JSON ---

interface Doctor {
    id: string;
    name: string;
    gender: string;
    specializations: string[];
    consultationFee: string;
    availability: string;
}

const dataPath = join(dirname(new URL(import.meta.url).pathname), 'data', 'doctors.json');
const doctors: Doctor[] = JSON.parse(readFileSync(dataPath, 'utf-8'));

// --- Mock State for Demo ---
const mockTokens: Record<string, number> = doctors.reduce((acc, d) => ({ ...acc, [d.id]: 17 }), {});

// Pending bookings store — used for the two-step booking flow (prepare → confirm)
const pendingBookings: Record<string, { doctorId: string; slot: string; patientName: string; phone: string; reason: string }> = {};

/**
 * Simulates an API call with latency
 */
async function callExternalApi<T>(name: string, data: any, result: T): Promise<T> {
    console.log(`[API Call] -> ${name}`, data);
    // Simulate network latency (500ms - 1.5s)
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
    console.log(`[API Response] <- ${name} success`);
    return result;
}

// --- Semantic Helpers ---

async function llmMatchCriteria(
    query: string,
    options: string[],
    type: 'doctor_name' | 'specialty'
): Promise<string | null> {
    if (!process.env.OPENAI_API_KEY) return null;

    try {
        const { text } = await generateText({
            model: openai('gpt-4o-mini') as any,
            temperature: 0,
            system: `You are a medical directory matching engine. 
            Given a user's query (which may have typos or be in another language like Sinhalese or Tamil), 
            map it to the closest EXACT string from the provided list.
            If no reasonable match exists, return "NONE".
            Type of match: ${type.replace('_', ' ')}.`,
            prompt: `User Query: "${query}"\nOptions:\n${options.join('\n')}`,
        });

        const match = text.trim();
        return options.includes(match) ? match : null;
    } catch (e) {
        console.error('LLM Match Error:', e);
        return null;
    }
}

// --- Logic Functions ---

export async function searchDoctors(query: string) {
    const availableSpecialties = Array.from(new Set(doctors.flatMap(d => d.specializations)));
    const availableNames = doctors.map(d => d.name);

    // 1. Try LLM Matching for specialty
    const matchedSpecialty = await llmMatchCriteria(query, availableSpecialties, 'specialty');

    // 2. Try LLM Matching for doctor name
    const matchedName = await llmMatchCriteria(query, availableNames, 'doctor_name');

    // 3. Fallback to basic fuzzy matching for safety/offline
    const normalizedQuery = query.toLowerCase().replace('dr.', '').replace('doctor', '').trim();

    let results = doctors.filter(d => {
        if (matchedSpecialty && d.specializations.includes(matchedSpecialty)) return true;
        if (matchedName && d.name === matchedName) return true;

        const nameVal = d.name.toLowerCase().replace('dr.', '').replace('doctor', '').trim();
        const specVals = d.specializations.map(s => s.toLowerCase());

        if (nameVal.includes(normalizedQuery) || normalizedQuery.includes(nameVal)) return true;

        const queryParts = normalizedQuery.split(/\s+/);
        const nameParts = nameVal.split(/\s+/);
        const partMatch = queryParts.some(qp => qp.length > 3 && nameParts.some(np => np.includes(qp) || qp.includes(np)));
        if (partMatch) return true;

        // Check if query matches any specialization via substring
        const specMatch = specVals.some(sv => sv.includes(normalizedQuery) || normalizedQuery.includes(sv));
        if (specMatch) return true;

        // Semantic/Typo matching for "Paediatrician"
        const pediaTypos = ['paed', 'pedia', 'pedi', 'paedi'];
        const isQueryPedia = pediaTypos.some(t => normalizedQuery.includes(t));
        const isSpecPedia = specVals.some(sv => sv.includes('paediatrician'));

        if (isQueryPedia && isSpecPedia) return true;

        return false;
    });

    // Remove duplicates if any
    results = Array.from(new Map(results.map(item => [item.id, item])).values());

    // Limit results to top 10 to avoid overwhelming the LLM context
    const limitedResults = results.slice(0, 10);

    // Attach current next tokens for demo purposes
    const resultsWithTokens = limitedResults.map(d => ({
        ...d,
        nextToken: mockTokens[d.id] || 1
    }));

    return callExternalApi('doctor_search', { query }, {
        count: results.length,
        showing: limitedResults.length,
        doctors: resultsWithTokens,
        matchedCriteria: matchedSpecialty || matchedName || (results.length > 0 ? 'fuzzy' : 'none'),
        note: results.length === 0 ? "No direct matches found." : (results.length > 10 ? `Showing 10 of ${results.length} results. Ask the patient to narrow their search.` : undefined)
    });
}

export async function prepareDoctorBooking(data: { doctorId: string, slot: string, patientName: string, phone: string, reason: string }) {
    // Validate required patient fields are not empty
    if (!data.patientName?.trim()) return { status: 'error', message: 'Patient name is required. Please ask the patient for their full name.' };
    if (!data.phone?.trim()) return { status: 'error', message: 'Phone number is required. Please ask the patient for their contact number.' };
    if (!data.reason?.trim()) return { status: 'error', message: 'Reason for appointment is required. Please ask the patient why they need the appointment.' };

    const doctor = doctors.find(d => d.id === data.doctorId);
    if (!doctor) return { status: 'error', message: 'Doctor not found.' };

    const pendingId = `PND-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    pendingBookings[pendingId] = data;

    return {
        status: 'pending_confirmation',
        pendingId,
        summary: {
            doctor: doctor.name,
            specializations: doctor.specializations.join(', '),
            slot: data.slot,
            fee: doctor.consultationFee,
            availability: doctor.availability,
            patientName: data.patientName,
            phone: data.phone,
            reason: data.reason,
        },
        instruction: 'Present the above summary to the patient and ask them to confirm. Then call confirm_booking with the pendingId.'
    };
}

export async function confirmDoctorBooking(pendingId: string) {
    const pending = pendingBookings[pendingId];
    if (!pending) return { status: 'error', message: 'No pending booking found. Please prepare a booking first.' };

    const doctor = doctors.find(d => d.id === pending.doctorId);
    const currToken = mockTokens[pending.doctorId] || 1;
    mockTokens[pending.doctorId] = currToken + 1;

    delete pendingBookings[pendingId];

    return callExternalApi('doctor_booking', pending, {
        status: 'success',
        bookingId: `BK-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
        doctorName: doctor?.name,
        tokenNumber: currToken,
        message: `Booking confirmed for ${doctor?.name}. Your rolling token number is ${currToken}.`
    });
}

export async function registerPatient(data: { name: string, phone: string, email?: string }) {
    return callExternalApi('patient_registration', data, {
        success: true,
        patientId: `PID-${Math.floor(Math.random() * 9000) + 1000}`,
        message: `Patient ${data.name} has been registered.`
    });
}

// --- Kuralle Tool Definitions ---

/**
 * Doctor Search Tool: Uses LLM-powered semantic matching.
 */
export const search_doctors = createTool({
    description: 'Search for doctors by name or specialty. Recommends specialists if specific names are not found.',
    inputSchema: z.object({
        query: z.string().describe('The name or specialty to search for'),
    }) as any,
    execute: async (args: any) => searchDoctors(args.query),
});

export const prepare_booking = createTool({
    description: 'Prepare a booking AFTER collecting all required patient details. This does NOT finalize the booking — it returns a summary that you MUST present to the patient before calling confirm_booking. All patient fields must be non-empty.',
    inputSchema: z.object({
        doctorId: z.string(),
        slot: z.string().describe('The selected time slot'),
        patientName: z.string().min(1, 'Patient name cannot be empty').describe('Full name of the patient — ask the patient if not known'),
        phone: z.string().min(1, 'Phone cannot be empty').describe('Patient contact phone number — ask the patient if not known'),
        reason: z.string().min(1, 'Reason cannot be empty').describe('Reason for the appointment — ask the patient if not known'),
    }) as any,
    execute: async (args: any) => prepareDoctorBooking(args),
});

export const confirm_booking = createTool({
    description: 'Finalize a prepared booking ONLY after the patient has explicitly confirmed. You must have called prepare_booking first and received a pendingId.',
    inputSchema: z.object({
        pendingId: z.string().describe('The pending booking ID returned by prepare_booking'),
    }) as any,
    execute: async (args: any) => confirmDoctorBooking(args.pendingId),
});

export const register_patient = createTool({
    description: 'Register a new patient into the hospital system.',
    inputSchema: z.object({
        name: z.string(),
        phone: z.string(),
        email: z.string().optional(),
    }) as any,
    execute: async (args: any) => registerPatient(args),
});

export const get_delivery_packages = createTool({
    description: 'Get information about delivery packages and pricing',
    inputSchema: z.object({
        type: z.enum(['normal', 'caesarean']).optional(),
    }) as any,
    execute: async (args: any) => {
        return callExternalApi('get_pricing', { type: args.type }, {
            packages: [
                { type: 'Normal Delivery', room: 'Deluxe', price: 'LKR 110,000', note: 'Prices exclude VAT' },
                { type: 'Caesarean Section', room: 'Deluxe', price: 'LKR 135,000', note: 'Prices exclude VAT' }
            ]
        });
    },
});

export const get_lab_report_status = createTool({
    description: 'Check the status of a laboratory report using a reference ID.',
    inputSchema: z.object({
        referenceId: z.string(),
    }) as any,
    execute: async (args: any) => {
        return callExternalApi('lab_report_lookup', { referenceId: args.referenceId }, {
            status: 'Ready',
            message: 'Your report is ready for download online.',
            availableDigitally: true
        });
    },
});

export const suggest_options = createTool({
    description: 'Display clickable suggestion buttons/chips to help users take quick actions. ALWAYS call this on the very first greeting with ["Book Appointment", "Check Availability", "Hospital Information"]. Also use after providing information to guide next steps (e.g., after showing fees, doctor lists, or service details). Max 3 options.',
    inputSchema: z.object({
        options: z.array(z.string().min(1).max(3)).describe('The list of labels for the suggestion buttons (1-3 options only)'),
    }) as any,
    execute: async (args: any) => {
        return {
            status: 'success',
            options: args.options,
            note: 'Suggestions have been sent to the UI.'
        };
    },
});
