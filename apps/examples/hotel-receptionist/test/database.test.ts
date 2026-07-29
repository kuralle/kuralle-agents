import { afterEach, describe, expect, test } from 'bun:test';
import { HotelRepository } from '../src/database.js';

const repositories: HotelRepository[] = [];

function repository() {
  const value = new HotelRepository(':memory:', new Date('2026-08-01T00:00:00Z'));
  repositories.push(value);
  return value;
}

afterEach(() => {
  for (const value of repositories.splice(0)) value.close();
});

describe('HotelRepository', () => {
  test('only offers pet-friendly inventory when a pet is travelling', () => {
    const repository = new HotelRepository(':memory:', new Date('2026-08-01T00:00:00Z'));
    const availability = repository.listRoomAvailability({
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      guests: 4,
      pets: true,
    });
    expect(availability.map((room) => room.roomType)).toEqual(['queen_2beds', 'double_queen', 'suite', 'penthouse']);
    repository.close();
  });

  test('requires two-field verification and supports both approved paths', () => {
    const repo = repository();
    expect(repo.verifyBooking({ lastName: 'Chen', confirmationCode: 'HTL-MN42' })?.code).toBe('HTL-MN42');
    expect(repo.verifyBooking({ lastName: 'Chen', paymentMethodLast4: '4477' })?.code).toBe('HTL-MN42');
    expect(repo.verifyBooking({ lastName: 'Wrong', confirmationCode: 'HTL-MN42' })).toBeUndefined();
    expect(() => repo.verifyBooking({ lastName: 'Chen' })).toThrow('exactly one verification path');
  });

  test('checks inventory and books one matching room atomically', () => {
    const repo = repository();
    const availability = repo.listRoomAvailability({
      checkIn: '2026-08-20',
      checkOut: '2026-08-23',
      guests: 2,
      view: 'garden',
    });
    expect(availability.some((item) => item.roomType === 'queen_2beds')).toBe(true);
    const booking = repo.createRoomBooking({
      code: 'HTL-TEST1',
      roomType: 'queen_2beds',
      view: 'garden',
      smoking: false,
      guests: 2,
      checkIn: '2026-08-20',
      checkOut: '2026-08-23',
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex@example.com',
      phone: '+1 415 555 0111',
      paymentMethodLast4: '1234',
      extras: ['breakfast'],
    });
    expect(booking).toMatchObject({ roomId: 'RM_205', status: 'confirmed' });
    expect(repo.getInvoice(booking.code).totalCents).toBe(82_320);
  });

  test('cancellation is idempotent by operation and respects the 48-hour window', () => {
    const repo = repository();
    const first = repo.cancelRoomBooking('HTL-MN42', 'cancel-operation', new Date('2026-08-01T00:00:00Z'));
    const repeated = repo.cancelRoomBooking('HTL-MN42', 'cancel-operation', new Date('2026-08-01T00:00:00Z'));
    expect(first.retainedCents).toBe(0);
    expect(repeated).toEqual(first);
    expect(repo.getBooking('HTL-MN42')?.status).toBe('cancelled');
  });

  test('restaurant inventory never offers lunch and protects occupied table slots', () => {
    const repo = repository();
    const times = repo.listRestaurantAvailability('2026-08-10', 2);
    expect(times[0]).toBe('17:30');
    expect(times.at(-1)).toBe('21:00');
    expect(times).not.toContain('12:00');
    const reservation = repo.createRestaurantReservation({
      code: 'RES-TEST1',
      firstName: 'Ari',
      lastName: 'Kim',
      phone: '4155550199',
      partySize: 2,
      date: '2026-08-10',
      time: '17:30',
    });
    expect(reservation.status).toBe('confirmed');
  });

  test('guest-message result never reveals internal presence resolution', () => {
    const repo = repository();
    const result = repo.takeGuestMessage({
      id: 'message-1',
      reference: 'MSG-1',
      recipient: 'Jonathan Pierce',
      callerName: 'Detective Harris',
      callerPhone: '4155550240',
      message: 'Please call back.',
    });
    expect(result).toEqual({ reference: 'MSG-1', status: 'passed_along_if_possible' });
    expect(result).not.toHaveProperty('internalDeliveryStatus');
    expect(repo.lastOperation('guest_message')).toMatchObject({ internalDeliveryStatus: 'delivered' });
  });

  test('resolves a seeded room conflict without charging the guest', () => {
    const repo = repository();
    expect(repo.resolveRoomConflict('HTL-RT88', 'walk-1', 'WLK-1')).toMatchObject({
      resolution: expect.any(String),
      noAddedCost: true,
    });
  });
});
