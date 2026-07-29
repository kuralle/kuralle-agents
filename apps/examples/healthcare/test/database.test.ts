import { afterEach, describe, expect, test } from 'bun:test';
import { HealthcareRepository } from '../src/database.js';

const repositories: HealthcareRepository[] = [];

function repository() {
  const value = new HealthcareRepository(':memory:', new Date('2026-08-01T00:00:00.000Z'));
  repositories.push(value);
  return value;
}

afterEach(() => {
  for (const value of repositories.splice(0)) value.close();
});

describe('HealthcareRepository', () => {
  test('authenticates only with the full name and date of birth pair', () => {
    const repo = repository();
    expect(repo.authenticatePatient('  MARY   JANE ', '2001-06-10')?.id).toBe('patient-mary');
    expect(repo.authenticatePatient('Mary Jane', '2001-06-11')).toBeUndefined();
    expect(repo.authenticatePatient('Mary', '2001-06-10')).toBeUndefined();
  });

  test('filters clinicians by insurance and exposes only available slots', () => {
    const repo = repository();
    expect(repo.listDoctors('Aetna').map((doctor) => doctor.id)).toEqual(['doctor-hyde']);
    expect(repo.listAvailableSlots('doctor-hyde')).toHaveLength(3);
  });

  test('claims a slot once, restores it on cancellation, and can reuse it', () => {
    const repo = repository();
    const appointment = repo.scheduleAppointment({
      id: 'appointment-1',
      patientId: 'patient-mary',
      doctorId: 'doctor-jekyll',
      slotId: 'jekyll-1',
      visitReason: 'Annual checkup',
    });
    expect(repo.listAvailableSlots('doctor-jekyll').map((slot) => slot.id)).not.toContain('jekyll-1');
    expect(() => repo.scheduleAppointment({
      id: 'appointment-2',
      patientId: 'patient-peter',
      doctorId: 'doctor-jekyll',
      slotId: 'jekyll-1',
      visitReason: 'Follow-up',
    })).toThrow('no longer available');

    repo.cancelAppointment('patient-mary', appointment.id);
    expect(repo.listAvailableSlots('doctor-jekyll').map((slot) => slot.id)).toContain('jekyll-1');
  });

  test('reschedules atomically and rejects cross-patient mutation', () => {
    const repo = repository();
    const appointment = repo.scheduleAppointment({
      id: 'appointment-1',
      patientId: 'patient-mary',
      doctorId: 'doctor-jekyll',
      slotId: 'jekyll-1',
      visitReason: 'Annual checkup',
    });
    const updated = repo.rescheduleAppointment('patient-mary', appointment.id, 'hyde-1');
    expect(updated).toMatchObject({ doctorId: 'doctor-hyde', slotId: 'hyde-1' });
    expect(repo.listAvailableSlots('doctor-jekyll').map((slot) => slot.id)).toContain('jekyll-1');
    expect(() => repo.cancelAppointment('patient-peter', appointment.id)).toThrow('not found');
  });

  test('applies a payment idempotently and prevents overpayment', () => {
    const repo = repository();
    expect(repo.payBalance('patient-mary', 2500, 'payment-1').outstandingBalanceCents).toBe(10075);
    expect(repo.payBalance('patient-mary', 2500, 'payment-1').outstandingBalanceCents).toBe(10075);
    expect(() => repo.payBalance('patient-mary', 20000, 'payment-2')).toThrow('exceeds');
  });
});
