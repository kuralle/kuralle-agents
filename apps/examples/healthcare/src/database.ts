import { Database, type SQLQueryBindings } from 'bun:sqlite';

export const ACCEPTED_INSURERS = ['Anthem', 'Aetna', 'EmblemHealth', 'HealthFirst'] as const;
export type AcceptedInsurer = (typeof ACCEPTED_INSURERS)[number];

export interface Patient {
  id: string;
  name: string;
  dateOfBirth: string;
  phoneNumber: string;
  insurance: AcceptedInsurer;
  outstandingBalanceCents: number;
  paymentMethodLast4: string;
}

export interface Doctor {
  id: string;
  name: string;
  acceptedInsurances: AcceptedInsurer[];
}

export interface AppointmentSlot {
  id: string;
  doctorId: string;
  doctorName: string;
  startsAt: string;
}

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName: string;
  slotId: string;
  startsAt: string;
  visitReason: string;
  status: 'scheduled' | 'cancelled';
}

interface PatientRow {
  id: string;
  name: string;
  date_of_birth: string;
  phone_number: string;
  insurance: AcceptedInsurer;
  outstanding_balance_cents: number;
  payment_method_last4: string;
}

interface DoctorRow {
  id: string;
  name: string;
}

interface SlotRow {
  id: string;
  doctor_id: string;
  doctor_name: string;
  starts_at: string;
}

interface AppointmentRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  doctor_name: string;
  slot_id: string;
  starts_at: string;
  visit_reason: string;
  status: 'scheduled' | 'cancelled';
}

export class HealthcareRepository {
  readonly database: Database;

  constructor(path = ':memory:', seedDate = new Date()) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.run('PRAGMA foreign_keys = ON');
    this.database.run('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.database.run('PRAGMA journal_mode = WAL');
    this.migrate();
    this.seed(seedDate);
  }

  close(): void {
    this.database.close();
  }

  authenticatePatient(name: string, dateOfBirth: string): Patient | undefined {
    const row = this.database.query<PatientRow, [string, string]>(`
      SELECT id, name, date_of_birth, phone_number, insurance,
             outstanding_balance_cents, payment_method_last4
      FROM patients
      WHERE normalized_name = ? AND date_of_birth = ?
    `).get(normalizeName(name), dateOfBirth);
    return row ? patientFromRow(row) : undefined;
  }

  getPatient(id: string): Patient | undefined {
    const row = this.database.query<PatientRow, [string]>(`
      SELECT id, name, date_of_birth, phone_number, insurance,
             outstanding_balance_cents, payment_method_last4
      FROM patients WHERE id = ?
    `).get(id);
    return row ? patientFromRow(row) : undefined;
  }

  createPatient(input: {
    id: string;
    name: string;
    dateOfBirth: string;
    phoneNumber: string;
    insurance: AcceptedInsurer;
  }): Patient {
    this.run(`
      INSERT INTO patients (
        id, name, normalized_name, date_of_birth, phone_number, insurance,
        outstanding_balance_cents, payment_method_last4
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'none')
    `, input.id, input.name.trim(), normalizeName(input.name), input.dateOfBirth,
    input.phoneNumber, input.insurance);
    return this.getPatient(input.id)!;
  }

  updatePatient(
    patientId: string,
    field: 'phoneNumber' | 'insurance',
    value: string,
  ): Patient {
    if (field === 'insurance' && !isAcceptedInsurer(value)) {
      throw new Error(`Insurance must be one of: ${ACCEPTED_INSURERS.join(', ')}.`);
    }
    const column = field === 'phoneNumber' ? 'phone_number' : 'insurance';
    const changed = this.run(`UPDATE patients SET ${column} = ? WHERE id = ?`, value, patientId);
    if (changed.changes !== 1) throw new Error('Patient record was not found.');
    return this.getPatient(patientId)!;
  }

  listDoctors(insurance?: AcceptedInsurer): Doctor[] {
    const rows = insurance
      ? this.database.query<DoctorRow, [string]>(`
          SELECT d.id, d.name FROM doctors d
          JOIN doctor_insurances i ON i.doctor_id = d.id
          WHERE i.insurance = ? ORDER BY d.name
        `).all(insurance)
      : this.database.query<DoctorRow, []>('SELECT id, name FROM doctors ORDER BY name').all();

    const insuranceQuery = this.database.query<{ insurance: AcceptedInsurer }, [string]>(
      'SELECT insurance FROM doctor_insurances WHERE doctor_id = ? ORDER BY insurance',
    );
    return rows.map((row) => ({
      ...row,
      acceptedInsurances: insuranceQuery.all(row.id).map((item) => item.insurance),
    }));
  }

  listAvailableSlots(doctorId: string): AppointmentSlot[] {
    return this.database.query<SlotRow, [string]>(`
      SELECT s.id, s.doctor_id, d.name AS doctor_name, s.starts_at
      FROM appointment_slots s
      JOIN doctors d ON d.id = s.doctor_id
      WHERE s.doctor_id = ? AND s.status = 'available'
      ORDER BY s.starts_at
    `).all(doctorId).map(slotFromRow);
  }

  scheduleAppointment(input: {
    id: string;
    patientId: string;
    doctorId: string;
    slotId: string;
    visitReason: string;
  }): Appointment {
    return this.database.transaction(() => {
      const existing = this.database.query<AppointmentRow, [string, string]>(`
        SELECT a.*, d.name AS doctor_name, s.starts_at
        FROM appointments a JOIN doctors d ON d.id = a.doctor_id
        JOIN appointment_slots s ON s.id = a.slot_id
        WHERE a.patient_id = ? AND a.slot_id = ? AND a.status = 'scheduled'
      `).get(input.patientId, input.slotId);
      if (existing) return appointmentFromRow(existing);

      const claimed = this.run(`
        UPDATE appointment_slots SET status = 'booked'
        WHERE id = ? AND doctor_id = ? AND status = 'available'
      `, input.slotId, input.doctorId);
      if (claimed.changes !== 1) throw new Error('That appointment slot is no longer available.');
      this.run(`
        INSERT INTO appointments (
          id, patient_id, doctor_id, slot_id, visit_reason, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'scheduled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, input.id, input.patientId, input.doctorId, input.slotId, input.visitReason.trim());
      return this.getAppointment(input.patientId, input.id)!;
    }).immediate();
  }

  listAppointments(patientId: string, includeCancelled = false): Appointment[] {
    const statusClause = includeCancelled ? '' : "AND a.status = 'scheduled'";
    return this.database.query<AppointmentRow, [string]>(`
      SELECT a.*, d.name AS doctor_name, s.starts_at
      FROM appointments a JOIN doctors d ON d.id = a.doctor_id
      JOIN appointment_slots s ON s.id = a.slot_id
      WHERE a.patient_id = ? ${statusClause}
      ORDER BY s.starts_at
    `).all(patientId).map(appointmentFromRow);
  }

  cancelAppointment(patientId: string, appointmentId: string): Appointment {
    return this.database.transaction(() => {
      const appointment = this.getAppointment(patientId, appointmentId);
      if (!appointment) throw new Error('Appointment was not found for the authenticated patient.');
      if (appointment.status === 'cancelled') return appointment;
      this.run(
        "UPDATE appointments SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        appointmentId,
      );
      this.run("UPDATE appointment_slots SET status = 'available' WHERE id = ?", appointment.slotId);
      return this.getAppointment(patientId, appointmentId)!;
    }).immediate();
  }

  rescheduleAppointment(
    patientId: string,
    appointmentId: string,
    newSlotId: string,
  ): Appointment {
    return this.database.transaction(() => {
      const current = this.getAppointment(patientId, appointmentId);
      if (!current || current.status !== 'scheduled') {
        throw new Error('A scheduled appointment was not found for the authenticated patient.');
      }
      if (current.slotId === newSlotId) return current;
      const next = this.database.query<{ doctor_id: string }, [string]>(
        "SELECT doctor_id FROM appointment_slots WHERE id = ? AND status = 'available'",
      ).get(newSlotId);
      if (!next) throw new Error('The requested replacement slot is no longer available.');
      const claimed = this.run(
        "UPDATE appointment_slots SET status = 'booked' WHERE id = ? AND status = 'available'",
        newSlotId,
      );
      if (claimed.changes !== 1) throw new Error('The requested replacement slot is no longer available.');
      this.run("UPDATE appointment_slots SET status = 'available' WHERE id = ?", current.slotId);
      this.run(`
        UPDATE appointments SET doctor_id = ?, slot_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, next.doctor_id, newSlotId, appointmentId);
      return this.getAppointment(patientId, appointmentId)!;
    }).immediate();
  }

  payBalance(patientId: string, amountCents: number, paymentId: string): Patient {
    return this.database.transaction(() => {
      const existingPayment = this.database.query<{ amount_cents: number }, [string, string]>(
        'SELECT amount_cents FROM payments WHERE id = ? AND patient_id = ?',
      ).get(paymentId, patientId);
      if (existingPayment) {
        if (existingPayment.amount_cents !== amountCents) throw new Error('Payment idempotency conflict.');
        return this.getPatient(patientId)!;
      }
      const patient = this.getPatient(patientId);
      if (!patient) throw new Error('Patient record was not found.');
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        throw new Error('Payment must be a positive amount in whole cents.');
      }
      if (amountCents > patient.outstandingBalanceCents) {
        throw new Error(`Payment exceeds the outstanding balance of ${formatMoney(patient.outstandingBalanceCents)}.`);
      }
      this.run(`
        INSERT INTO payments (id, patient_id, amount_cents, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `, paymentId, patientId, amountCents);
      this.run(`
        UPDATE patients SET outstanding_balance_cents = outstanding_balance_cents - ?
        WHERE id = ? AND NOT EXISTS (
          SELECT 1 FROM payment_applications WHERE payment_id = ?
        )
      `, amountCents, patientId, paymentId);
      this.run(
        'INSERT OR IGNORE INTO payment_applications (payment_id) VALUES (?)',
        paymentId,
      );
      return this.getPatient(patientId)!;
    }).immediate();
  }

  createSupportRequest(input: { id: string; patientId?: string; reason: string }): string {
    this.run(`
      INSERT INTO support_requests (id, patient_id, reason, status, created_at)
      VALUES (?, ?, ?, 'open', CURRENT_TIMESTAMP)
    `, input.id, input.patientId ?? null, input.reason.trim());
    return input.id;
  }

  private getAppointment(patientId: string, appointmentId: string): Appointment | undefined {
    const row = this.database.query<AppointmentRow, [string, string]>(`
      SELECT a.*, d.name AS doctor_name, s.starts_at
      FROM appointments a JOIN doctors d ON d.id = a.doctor_id
      JOIN appointment_slots s ON s.id = a.slot_id
      WHERE a.patient_id = ? AND a.id = ?
    `).get(patientId, appointmentId);
    return row ? appointmentFromRow(row) : undefined;
  }

  private migrate(): void {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        date_of_birth TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        insurance TEXT NOT NULL,
        outstanding_balance_cents INTEGER NOT NULL CHECK (outstanding_balance_cents >= 0),
        payment_method_last4 TEXT NOT NULL,
        UNIQUE(normalized_name, date_of_birth)
      );
      CREATE TABLE IF NOT EXISTS doctors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS doctor_insurances (
        doctor_id TEXT NOT NULL REFERENCES doctors(id),
        insurance TEXT NOT NULL,
        PRIMARY KEY (doctor_id, insurance)
      );
      CREATE TABLE IF NOT EXISTS appointment_slots (
        id TEXT PRIMARY KEY,
        doctor_id TEXT NOT NULL REFERENCES doctors(id),
        starts_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('available', 'booked')),
        UNIQUE(doctor_id, starts_at)
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        doctor_id TEXT NOT NULL REFERENCES doctors(id),
        slot_id TEXT NOT NULL REFERENCES appointment_slots(id),
        visit_reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_applications (
        payment_id TEXT PRIMARY KEY REFERENCES payments(id)
      );
      CREATE TABLE IF NOT EXISTS support_requests (
        id TEXT PRIMARY KEY,
        patient_id TEXT REFERENCES patients(id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        created_at TEXT NOT NULL
      );
    `);
  }

  private seed(seedDate: Date): void {
    const count = this.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM doctors').get()?.count ?? 0;
    if (count > 0) return;

    this.database.transaction(() => {
      this.database.run("INSERT INTO doctors (id, name) VALUES ('doctor-jekyll', 'Dr. Henry Jekyll')");
      this.database.run("INSERT INTO doctors (id, name) VALUES ('doctor-hyde', 'Dr. Edward Hyde')");
      for (const insurance of ['Anthem', 'HealthFirst']) {
        this.run('INSERT INTO doctor_insurances VALUES (?, ?)', 'doctor-jekyll', insurance);
      }
      for (const insurance of ['Anthem', 'Aetna', 'EmblemHealth']) {
        this.run('INSERT INTO doctor_insurances VALUES (?, ?)', 'doctor-hyde', insurance);
      }
      this.database.run(`
        INSERT INTO patients VALUES
          ('patient-mary', 'Mary Jane', 'mary jane', '2001-06-10', '+18005882300', 'Anthem', 12575, '4242'),
          ('patient-peter', 'Peter Parker', 'peter parker', '2001-08-10', '+17185551962', 'Aetna', 8000, '1881')
      `);
      const slots: Array<[string, string, number, number, number]> = [
        ['jekyll-1', 'doctor-jekyll', 2, 9, 30],
        ['jekyll-2', 'doctor-jekyll', 4, 14, 30],
        ['jekyll-3', 'doctor-jekyll', 7, 11, 0],
        ['hyde-1', 'doctor-hyde', 1, 10, 0],
        ['hyde-2', 'doctor-hyde', 3, 14, 30],
        ['hyde-3', 'doctor-hyde', 5, 15, 45],
      ];
      for (const [id, doctorId, dayOffset, hour, minute] of slots) {
        this.run(
          "INSERT INTO appointment_slots VALUES (?, ?, ?, 'available')",
          id,
          doctorId,
          futureUtc(seedDate, dayOffset, hour, minute),
        );
      }
    }).immediate();
  }

  private run(sql: string, ...bindings: SQLQueryBindings[]) {
    return this.database.run(sql, bindings);
  }
}

export function isAcceptedInsurer(value: string): value is AcceptedInsurer {
  return ACCEPTED_INSURERS.includes(value as AcceptedInsurer);
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function patientFromRow(row: PatientRow): Patient {
  return {
    id: row.id,
    name: row.name,
    dateOfBirth: row.date_of_birth,
    phoneNumber: row.phone_number,
    insurance: row.insurance,
    outstandingBalanceCents: row.outstanding_balance_cents,
    paymentMethodLast4: row.payment_method_last4,
  };
}

function slotFromRow(row: SlotRow): AppointmentSlot {
  return { id: row.id, doctorId: row.doctor_id, doctorName: row.doctor_name, startsAt: row.starts_at };
}

function appointmentFromRow(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    slotId: row.slot_id,
    startsAt: row.starts_at,
    visitReason: row.visit_reason,
    status: row.status,
  };
}

function futureUtc(base: Date, dayOffset: number, hour: number, minute: number): string {
  return new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate() + dayOffset,
    hour,
    minute,
  )).toISOString();
}
