import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  PRICING,
  calculateStayTotal,
  type RoomExtra,
  type RoomType,
  type RoomView,
} from './catalog.js';

export interface RoomAvailability {
  roomType: RoomType;
  nightlyRateCents: number;
  views: RoomView[];
}

export interface RoomBooking {
  code: string;
  roomId: string;
  roomType: RoomType;
  roomView: RoomView;
  nightlyRateCents: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  extras: RoomExtra[];
  totalCents: number;
  paymentMethodLast4: string;
  status: 'confirmed' | 'cancelled';
}

export interface RestaurantReservation {
  code: string;
  tableLabel: string;
  firstName: string;
  lastName: string;
  phone: string;
  partySize: number;
  date: string;
  time: string;
  notes?: string;
  status: 'confirmed' | 'cancelled';
}

export interface Invoice {
  bookingCode: string;
  lineItems: Array<{ label: string; amountCents: number }>;
  subtotalCents: number;
  taxesCents: number;
  totalCents: number;
  paid: boolean;
}

interface BookingRow {
  code: string;
  room_id: string;
  room_type: RoomType;
  room_view: RoomView;
  nightly_rate: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  check_in: string;
  check_out: string;
  guests: number;
  extras: string;
  total: number;
  card_last4: string;
  status: 'confirmed' | 'cancelled';
}

interface ReservationRow {
  code: string;
  table_label: string;
  first_name: string;
  last_name: string;
  phone: string;
  party_size: number;
  date: string;
  time: string;
  notes: string | null;
  status: 'confirmed' | 'cancelled';
}

interface InvoiceRow {
  booking_code: string;
  line_items: string;
  subtotal: number;
  taxes: number;
  total: number;
  paid: number;
}

export class HotelRepository {
  readonly database: Database;
  readonly today: string;

  constructor(path = ':memory:', seedDate = new Date()) {
    this.database = new Database(path, { create: true, strict: true });
    this.today = isoDate(seedDate);
    this.database.run('PRAGMA foreign_keys = ON');
    this.database.run('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.database.run('PRAGMA journal_mode = WAL');
    this.migrate();
    this.seed(seedDate);
  }

  close(): void {
    this.database.close();
  }

  listRoomAvailability(input: {
    checkIn: string;
    checkOut: string;
    guests: number;
    smoking?: boolean;
    pets?: boolean;
    view?: RoomView;
    excludeBookingCode?: string;
  }): RoomAvailability[] {
    validateStay(input.checkIn, input.checkOut, input.guests, this.today);
    const rows = this.database.query<{
      type: RoomType;
      nightly_rate: number;
      room_view: RoomView;
    }, [number, number | null, number | null, number, string | null, string | null, string | null, string | null, string, string]>(`
      SELECT r.type, r.nightly_rate, r.room_view
      FROM hotel_rooms r
      WHERE r.max_occupancy >= ?
        AND (? IS NULL OR r.smoking = ?)
        AND (? = 0 OR r.pets_allowed = 1)
        AND (? IS NULL OR r.room_view = ?)
        AND NOT EXISTS (
          SELECT 1 FROM hotel_bookings b
          WHERE b.room_id = r.id AND b.status = 'confirmed'
            AND (? IS NULL OR b.code != ?)
            AND NOT (b.check_out <= ? OR b.check_in >= ?)
        )
      ORDER BY r.nightly_rate, r.type, r.room_view
    `).all(
      input.guests,
      input.smoking === undefined ? null : Number(input.smoking),
      input.smoking === undefined ? null : Number(input.smoking),
      Number(input.pets ?? false),
      input.view ?? null,
      input.view ?? null,
      input.excludeBookingCode ?? null,
      input.excludeBookingCode ?? null,
      input.checkIn,
      input.checkOut,
    );

    const grouped = new Map<RoomType, RoomAvailability>();
    for (const row of rows) {
      const existing = grouped.get(row.type);
      if (existing) {
        if (!existing.views.includes(row.room_view)) existing.views.push(row.room_view);
        existing.nightlyRateCents = Math.min(existing.nightlyRateCents, row.nightly_rate);
      } else {
        grouped.set(row.type, {
          roomType: row.type,
          nightlyRateCents: row.nightly_rate,
          views: [row.room_view],
        });
      }
    }
    return [...grouped.values()];
  }

  createRoomBooking(input: {
    code: string;
    roomType: RoomType;
    view?: RoomView;
    smoking: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    paymentMethodLast4: string;
    extras: RoomExtra[];
  }): RoomBooking {
    validateStay(input.checkIn, input.checkOut, input.guests, this.today);
    validateLast4(input.paymentMethodLast4);
    return this.database.transaction(() => {
      const room = this.findFreeRoom({ ...input, pets: input.extras.includes('pets') });
      if (!room) throw new Error('No matching room remains available for those dates.');
      const nights = daysBetween(input.checkIn, input.checkOut);
      const pricing = calculateStayTotal(room.nightly_rate, nights, input.extras);
      this.run(`
        INSERT INTO hotel_bookings (
          code, room_id, first_name, last_name, email, phone, check_in, check_out,
          guests, extras, total, card_last4, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
      `, input.code, room.id, cleanName(input.firstName), cleanName(input.lastName),
      input.email.trim().toLowerCase(), digits(input.phone), input.checkIn, input.checkOut,
      input.guests, [...new Set(input.extras)].sort().join(','), pricing.total,
      input.paymentMethodLast4);
      this.upsertInvoice(input.code, room.nightly_rate, nights, input.extras);
      return this.getBooking(input.code)!;
    }).immediate();
  }

  verifyBooking(input: {
    lastName: string;
    confirmationCode?: string;
    paymentMethodLast4?: string;
    allowCancelled?: boolean;
  }): RoomBooking | undefined {
    if (Boolean(input.confirmationCode) === Boolean(input.paymentMethodLast4)) {
      throw new Error('Use exactly one verification path: confirmation code or payment-method last four.');
    }
    if (input.paymentMethodLast4) validateLast4(input.paymentMethodLast4);
    const status = input.allowCancelled ? '' : "AND b.status = 'confirmed'";
    const row = this.database.query<BookingRow, [string, string | null, string | null, string | null, string | null]>(`
      SELECT b.*, r.type AS room_type, r.room_view, r.nightly_rate
      FROM hotel_bookings b JOIN hotel_rooms r ON r.id = b.room_id
      WHERE LOWER(b.last_name) = LOWER(?)
        AND (? IS NULL OR UPPER(b.code) = UPPER(?))
        AND (? IS NULL OR b.card_last4 = ?)
        ${status}
      LIMIT 1
    `).get(
      input.lastName.trim(),
      input.confirmationCode ?? null,
      input.confirmationCode ?? null,
      input.paymentMethodLast4 ?? null,
      input.paymentMethodLast4 ?? null,
    );
    return row ? bookingFromRow(row) : undefined;
  }

  getBooking(code: string): RoomBooking | undefined {
    const row = this.database.query<BookingRow, [string]>(`
      SELECT b.*, r.type AS room_type, r.room_view, r.nightly_rate
      FROM hotel_bookings b JOIN hotel_rooms r ON r.id = b.room_id
      WHERE UPPER(b.code) = UPPER(?)
    `).get(code);
    return row ? bookingFromRow(row) : undefined;
  }

  modifyRoomBooking(input: {
    code: string;
    roomType: RoomType;
    view?: RoomView;
    smoking: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    extras: RoomExtra[];
  }): RoomBooking {
    validateStay(input.checkIn, input.checkOut, input.guests, this.today);
    return this.database.transaction(() => {
      const current = this.getBooking(input.code);
      if (!current || current.status !== 'confirmed') throw new Error('Confirmed booking was not found.');
      const room = this.findFreeRoom({
        ...input,
        pets: input.extras.includes('pets'),
        excludeBookingCode: input.code,
        preferRoomId: current.roomId,
      });
      if (!room) throw new Error('No matching replacement room is available.');
      const nights = daysBetween(input.checkIn, input.checkOut);
      const pricing = calculateStayTotal(room.nightly_rate, nights, input.extras);
      this.run(`
        UPDATE hotel_bookings SET room_id = ?, check_in = ?, check_out = ?, guests = ?,
          extras = ?, total = ? WHERE code = ? AND status = 'confirmed'
      `, room.id, input.checkIn, input.checkOut, input.guests,
      [...new Set(input.extras)].sort().join(','), pricing.total, input.code);
      this.upsertInvoice(input.code, room.nightly_rate, nights, input.extras);
      return this.getBooking(input.code)!;
    }).immediate();
  }

  cancelRoomBooking(code: string, operationId: string, now = new Date()): {
    booking: RoomBooking;
    refundCents: number;
    retainedCents: number;
  } {
    return this.database.transaction(() => {
      const booking = this.getBooking(code);
      if (!booking) throw new Error('Booking was not found.');
      const existing = this.database.query<{ payload: string }, [string]>(
        "SELECT payload FROM hotel_operations WHERE id = ? AND kind = 'room_cancellation'",
      ).get(operationId);
      if (existing) return JSON.parse(existing.payload) as { booking: RoomBooking; refundCents: number; retainedCents: number };
      if (booking.status === 'cancelled') {
        throw new Error('That booking is already cancelled.');
      }
      const checkIn = new Date(`${booking.checkIn}T15:00:00.000Z`);
      const outsideWindow = checkIn.getTime() - now.getTime() >= PRICING.cancellationWindowHours * 3_600_000;
      const retainedCents = outsideWindow
        ? 0
        : Math.min(booking.totalCents, Math.floor(booking.nightlyRateCents * 1.12));
      const refundCents = booking.totalCents - retainedCents;
      this.run("UPDATE hotel_bookings SET status = 'cancelled' WHERE code = ?", code);
      const cancelled = this.getBooking(code)!;
      const result = { booking: cancelled, refundCents, retainedCents };
      this.insertOperation(operationId, reference('CAN', operationId), 'room_cancellation', result);
      return result;
    }).immediate();
  }

  reinstateRoomBooking(code: string): RoomBooking {
    return this.database.transaction(() => {
      const booking = this.getBooking(code);
      if (!booking) throw new Error('Booking was not found.');
      if (booking.status === 'confirmed') return booking;
      const clash = this.database.query<{ found: number }, [string, string, string, string]>(`
        SELECT 1 AS found FROM hotel_bookings
        WHERE room_id = ? AND code != ? AND status = 'confirmed'
          AND NOT (check_out <= ? OR check_in >= ?) LIMIT 1
      `).get(booking.roomId, code, booking.checkIn, booking.checkOut);
      if (clash) throw new Error('The original room is no longer available for those dates.');
      this.run("UPDATE hotel_bookings SET status = 'confirmed' WHERE code = ?", code);
      return this.getBooking(code)!;
    }).immediate();
  }

  updatePaymentMethod(code: string, last4: string): RoomBooking {
    validateLast4(last4);
    const booking = this.getBooking(code);
    if (!booking) throw new Error('Booking was not found.');
    this.run('UPDATE hotel_bookings SET card_last4 = ? WHERE code = ?', last4, code);
    return this.getBooking(code)!;
  }

  flagLateArrival(code: string, note: string): RoomBooking {
    const changed = this.run(
      "UPDATE hotel_bookings SET late_arrival_note = ? WHERE code = ? AND status = 'confirmed'",
      note.trim(),
      code,
    );
    if (changed.changes !== 1) throw new Error('Confirmed booking was not found.');
    return this.getBooking(code)!;
  }

  getInvoice(code: string): Invoice {
    const row = this.database.query<InvoiceRow, [string]>(`
      SELECT booking_code, line_items, subtotal, taxes, total, paid
      FROM hotel_invoices WHERE UPPER(booking_code) = UPPER(?)
    `).get(code);
    if (!row) throw new Error('Invoice was not found.');
    return invoiceFromRow(row);
  }

  fileDispute(input: {
    id: string;
    reference: string;
    bookingCode: string;
    lineItem: string;
    amountCents: number;
    category: string;
    callerNote: string;
  }) {
    const invoice = this.getInvoice(input.bookingCode);
    if (input.amountCents <= 0 || input.amountCents > invoice.totalCents) {
      throw new Error('Disputed amount must be positive and cannot exceed the invoice total.');
    }
    this.run(`
      INSERT INTO hotel_disputes (
        id, reference, booking_code, line_item, amount, category, caller_note, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP)
    `, input.id, input.reference, input.bookingCode, input.lineItem.trim(), input.amountCents,
    input.category, input.callerNote.trim());
    return { reference: input.reference, status: 'open', invoiceTotalCents: invoice.totalCents };
  }

  listRestaurantAvailability(date: string, partySize: number): string[] {
    if (date < this.today) throw new Error('Restaurant date cannot be in the past.');
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 12) throw new Error('Party size must be between 1 and 12.');
    const slots: string[] = [];
    for (let minutes = 17 * 60 + 30; minutes <= 21 * 60; minutes += 30) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const available = this.database.query<{ found: number }, [number, string, string]>(`
        SELECT 1 AS found FROM restaurant_tables t
        WHERE t.capacity >= ? AND NOT EXISTS (
          SELECT 1 FROM restaurant_reservations r
          WHERE r.table_id = t.id AND r.date = ? AND r.time = ? AND r.status = 'confirmed'
        ) LIMIT 1
      `).get(partySize, date, time);
      if (available) slots.push(time);
    }
    return slots;
  }

  createRestaurantReservation(input: {
    code: string;
    firstName: string;
    lastName: string;
    phone: string;
    partySize: number;
    date: string;
    time: string;
    notes?: string;
  }): RestaurantReservation {
    if (!this.listRestaurantAvailability(input.date, input.partySize).includes(input.time)) {
      throw new Error('That restaurant time is unavailable or outside dinner service.');
    }
    return this.database.transaction(() => {
      const table = this.database.query<{ id: number }, [number, string, string]>(`
        SELECT t.id FROM restaurant_tables t
        WHERE t.capacity >= ? AND NOT EXISTS (
          SELECT 1 FROM restaurant_reservations r
          WHERE r.table_id = t.id AND r.date = ? AND r.time = ? AND r.status = 'confirmed'
        ) ORDER BY t.capacity, t.id LIMIT 1
      `).get(input.partySize, input.date, input.time);
      if (!table) throw new Error('That restaurant time was just taken.');
      this.run(`
        INSERT INTO restaurant_reservations (
          code, table_id, first_name, last_name, phone, party_size, date, time, notes, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
      `, input.code, table.id, cleanName(input.firstName), cleanName(input.lastName),
      digits(input.phone), input.partySize, input.date, input.time, input.notes?.trim() ?? null);
      return this.getRestaurantReservation(input.lastName, input.code)!;
    }).immediate();
  }

  getRestaurantReservation(lastName: string, code: string): RestaurantReservation | undefined {
    const row = this.database.query<ReservationRow, [string, string]>(`
      SELECT r.*, t.label AS table_label FROM restaurant_reservations r
      JOIN restaurant_tables t ON t.id = r.table_id
      WHERE LOWER(r.last_name) = LOWER(?) AND UPPER(r.code) = UPPER(?)
    `).get(lastName.trim(), code);
    return row ? reservationFromRow(row) : undefined;
  }

  cancelRestaurantReservation(lastName: string, code: string): RestaurantReservation {
    const reservation = this.getRestaurantReservation(lastName, code);
    if (!reservation) throw new Error('Restaurant reservation was not found.');
    if (reservation.status !== 'cancelled') {
      this.run("UPDATE restaurant_reservations SET status = 'cancelled' WHERE code = ?", code);
    }
    return this.getRestaurantReservation(lastName, code)!;
  }

  modifyRestaurantReservation(input: {
    lastName: string;
    code: string;
    date: string;
    time: string;
    partySize: number;
  }): RestaurantReservation {
    const current = this.getRestaurantReservation(input.lastName, input.code);
    if (!current || current.status !== 'confirmed') throw new Error('Confirmed restaurant reservation was not found.');
    return this.database.transaction(() => {
      const table = this.database.query<{ id: number }, [number, string, string, string, string]>(`
        SELECT t.id FROM restaurant_tables t WHERE t.capacity >= ? AND NOT EXISTS (
          SELECT 1 FROM restaurant_reservations r WHERE r.table_id = t.id
            AND r.date = ? AND r.time = ? AND r.status = 'confirmed' AND r.code != ?
        ) ORDER BY CASE WHEN t.label = ? THEN 0 ELSE 1 END, t.capacity LIMIT 1
      `).get(input.partySize, input.date, input.time, input.code, current.tableLabel);
      if (!table || !isDinnerTime(input.time) || input.date < this.today) {
        throw new Error('The requested replacement table is unavailable.');
      }
      this.run(`
        UPDATE restaurant_reservations SET table_id = ?, date = ?, time = ?, party_size = ?
        WHERE code = ?
      `, table.id, input.date, input.time, input.partySize, input.code);
      return this.getRestaurantReservation(input.lastName, input.code)!;
    }).immediate();
  }

  recordOperation(input: { id: string; reference: string; kind: string; payload: Record<string, unknown> }) {
    this.insertOperation(input.id, input.reference, input.kind, input.payload);
    return { reference: input.reference, status: 'recorded' };
  }

  takeGuestMessage(input: {
    id: string;
    reference: string;
    recipient: string;
    callerName: string;
    callerPhone: string;
    message: string;
  }) {
    const inHouse = this.database.query<{ found: number }, [string, string, string]>(`
      SELECT 1 AS found FROM hotel_bookings
      WHERE LOWER(first_name || ' ' || last_name) = LOWER(?) AND status = 'confirmed'
        AND check_in <= ? AND check_out > ? LIMIT 1
    `).get(input.recipient.trim(), this.today, this.today);
    this.insertOperation(input.id, input.reference, 'guest_message', {
      recipient: input.recipient.trim(),
      callerName: cleanName(input.callerName),
      callerPhone: digits(input.callerPhone),
      message: input.message.trim(),
      internalDeliveryStatus: inHouse ? 'delivered' : 'undeliverable',
    });
    return { reference: input.reference, status: 'passed_along_if_possible' };
  }

  lookupGuestHistory(lastName: string): string | undefined {
    return this.database.query<{ preferences: string }, [string]>(
      'SELECT preferences FROM guest_history WHERE LOWER(last_name) = LOWER(?)',
    ).get(lastName.trim())?.preferences;
  }

  resendDocument(bookingCode: string, kind: 'booking_confirmation' | 'folio', id: string, emailReference: string) {
    const booking = this.getBooking(bookingCode);
    if (!booking) throw new Error('Booking was not found.');
    this.insertOperation(id, emailReference, 'email', {
      recipient: booking.email,
      kind,
      bookingCode,
    });
    return { reference: emailReference, recipient: maskEmail(booking.email), kind, status: 'sent' };
  }

  operationCount(kind: string): number {
    return this.database.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM hotel_operations WHERE kind = ?',
    ).get(kind)?.count ?? 0;
  }

  roomExists(room: string): boolean {
    return Boolean(this.database.query<{ found: number }, [string]>(
      'SELECT 1 AS found FROM hotel_rooms WHERE id = ? LIMIT 1',
    ).get(normalizeRoom(room)));
  }

  lastOperation(kind: string): Record<string, unknown> | undefined {
    const row = this.database.query<{ reference: string; payload: string; status: string }, [string]>(`
      SELECT reference, payload, status FROM hotel_operations
      WHERE kind = ? ORDER BY rowid DESC LIMIT 1
    `).get(kind);
    return row ? { reference: row.reference, status: row.status, ...JSON.parse(row.payload) as Record<string, unknown> } : undefined;
  }

  resolveRoomConflict(code: string, id: string, resultReference: string) {
    return this.database.transaction(() => {
      const booking = this.getBooking(code);
      if (!booking || booking.status !== 'confirmed') throw new Error('Confirmed booking was not found.');
      const clash = this.database.query<{ found: number }, [string, string, string, string]>(`
        SELECT 1 AS found FROM hotel_bookings WHERE room_id = ? AND code != ?
          AND status = 'confirmed' AND NOT (check_out <= ? OR check_in >= ?) LIMIT 1
      `).get(booking.roomId, booking.code, booking.checkIn, booking.checkOut);
      if (!clash) throw new Error('This booking has no room conflict.');
      const room = this.findFreeRoom({
        roomType: booking.roomType,
        smoking: false,
        guests: booking.guests,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        pets: booking.extras.includes('pets'),
        excludeBookingCode: booking.code,
      });
      if (room) {
        this.run('UPDATE hotel_bookings SET room_id = ? WHERE code = ?', room.id, code);
        return { resolution: 'moved_in_house', roomId: room.id, noAddedCost: true };
      }
      const payload = {
        resolution: 'walked',
        partnerHotel: 'Harbor House',
        hotelAndTaxiPaid: true,
        returnDate: addDays(this.today, 1),
      };
      this.insertOperation(id, resultReference, 'walk_arrangement', { bookingCode: code, ...payload });
      return payload;
    }).immediate();
  }

  private findFreeRoom(input: {
    roomType: RoomType;
    view?: RoomView;
    smoking: boolean;
    pets?: boolean;
    guests: number;
    checkIn: string;
    checkOut: string;
    excludeBookingCode?: string;
    preferRoomId?: string;
  }) {
    return this.database.query<{
      id: string;
      nightly_rate: number;
      type: RoomType;
      room_view: RoomView;
    }, [string, number, number, number, string | null, string | null, string | null, string | null, string, string, string]>(`
      SELECT r.id, r.nightly_rate, r.type, r.room_view FROM hotel_rooms r
      WHERE r.type = ? AND r.smoking = ? AND r.max_occupancy >= ?
        AND (? = 0 OR r.pets_allowed = 1)
        AND (? IS NULL OR r.room_view = ?)
        AND NOT EXISTS (
          SELECT 1 FROM hotel_bookings b WHERE b.room_id = r.id AND b.status = 'confirmed'
            AND (? IS NULL OR b.code != ?)
            AND NOT (b.check_out <= ? OR b.check_in >= ?)
        )
      ORDER BY CASE WHEN r.id = ? THEN 0 ELSE 1 END, r.nightly_rate, r.id LIMIT 1
    `).get(
      input.roomType,
      Number(input.smoking),
      input.guests,
      Number(input.pets ?? false),
      input.view ?? null,
      input.view ?? null,
      input.excludeBookingCode ?? null,
      input.excludeBookingCode ?? null,
      input.checkIn,
      input.checkOut,
      input.preferRoomId ?? '',
    );
  }

  private upsertInvoice(code: string, nightlyRate: number, nights: number, extras: RoomExtra[]) {
    const pricing = calculateStayTotal(nightlyRate, nights, extras);
    const lineItems = [
      { label: `Room (${nights} nights)`, amountCents: pricing.roomSubtotal },
      ...(pricing.extrasSubtotal > 0 ? [{ label: 'Selected extras', amountCents: pricing.extrasSubtotal }] : []),
      { label: `Tax (${PRICING.taxRatePercent}%)`, amountCents: pricing.taxes },
    ];
    this.run(`
      INSERT INTO hotel_invoices (booking_code, line_items, subtotal, taxes, total, paid)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(booking_code) DO UPDATE SET line_items = excluded.line_items,
        subtotal = excluded.subtotal, taxes = excluded.taxes, total = excluded.total
    `, code, JSON.stringify(lineItems), pricing.subtotal, pricing.taxes, pricing.total);
  }

  private insertOperation(id: string, operationReference: string, kind: string, payload: unknown) {
    this.run(`
      INSERT INTO hotel_operations (id, reference, kind, payload, status, created_at)
      VALUES (?, ?, ?, ?, 'recorded', CURRENT_TIMESTAMP)
    `, id, operationReference, kind, JSON.stringify(payload));
  }

  private migrate() {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS hotel_rooms (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        nightly_rate INTEGER NOT NULL CHECK (nightly_rate > 0),
        max_occupancy INTEGER NOT NULL CHECK (max_occupancy > 0),
        smoking INTEGER NOT NULL DEFAULT 0,
        pets_allowed INTEGER NOT NULL DEFAULT 0,
        room_view TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hotel_bookings (
        code TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES hotel_rooms(id),
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        check_in TEXT NOT NULL,
        check_out TEXT NOT NULL,
        guests INTEGER NOT NULL CHECK (guests > 0),
        extras TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL,
        card_last4 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
        late_arrival_note TEXT,
        CHECK (check_out > check_in)
      );
      CREATE TABLE IF NOT EXISTS hotel_invoices (
        booking_code TEXT PRIMARY KEY REFERENCES hotel_bookings(code),
        line_items TEXT NOT NULL,
        subtotal INTEGER NOT NULL,
        taxes INTEGER NOT NULL,
        total INTEGER NOT NULL,
        paid INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS restaurant_tables (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        capacity INTEGER NOT NULL,
        location TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS restaurant_reservations (
        code TEXT PRIMARY KEY,
        table_id INTEGER NOT NULL REFERENCES restaurant_tables(id),
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        party_size INTEGER NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS restaurant_slot
        ON restaurant_reservations(date, time, table_id) WHERE status = 'confirmed';
      CREATE TABLE IF NOT EXISTS hotel_operations (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hotel_disputes (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        booking_code TEXT NOT NULL REFERENCES hotel_bookings(code),
        line_item TEXT NOT NULL,
        amount INTEGER NOT NULL,
        category TEXT NOT NULL,
        caller_note TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guest_history (
        last_name TEXT PRIMARY KEY,
        preferences TEXT NOT NULL
      );
    `);
  }

  private seed(seedDate: Date) {
    const count = this.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM hotel_rooms').get()?.count ?? 0;
    if (count > 0) return;
    const rooms = [
      ['RM_201', 'king', 24000, 2, 0, 0, 'city'],
      ['RM_202', 'king', 26000, 2, 0, 1, 'ocean'],
      ['RM_203', 'king', 24000, 2, 1, 0, 'city'],
      ['RM_204', 'queen_2beds', 22000, 4, 0, 0, 'city'],
      ['RM_205', 'queen_2beds', 22000, 4, 0, 1, 'garden'],
      ['RM_206', 'double_queen', 26000, 4, 0, 0, 'ocean'],
      ['RM_301', 'king', 28000, 2, 0, 0, 'ocean'],
      ['RM_302', 'king', 28000, 2, 0, 0, 'ocean'],
      ['RM_303', 'queen_2beds', 24000, 4, 0, 0, 'city'],
      ['RM_304', 'double_queen', 28000, 4, 0, 1, 'ocean'],
      ['RM_401', 'suite', 48000, 4, 0, 1, 'ocean'],
      ['RM_402', 'suite', 52000, 4, 0, 0, 'ocean'],
      ['RM_408', 'suite', 50000, 4, 0, 0, 'city'],
      ['RM_PH', 'penthouse', 120000, 6, 0, 1, 'ocean'],
    ] as const;
    const tables = [
      ['T-01', 2, 'indoor'], ['T-02', 2, 'indoor'], ['T-03', 4, 'indoor'],
      ['T-04', 4, 'terrace'], ['T-05', 6, 'indoor'], ['P-01', 2, 'terrace'],
    ] as const;
    const bookings = [
      ['HTL-DH27', 'RM_301', 'Dana', 'Holt', 'dana.holt@example.com', '+14155550341', -2, 3, 2, '', 9034],
      ['HTL-RT88', 'RM_301', 'Kenji', 'Tanaka', 'kenji.tanaka@example.com', '+14155550164', 0, 3, 2, 'valet', 7782],
      ['HTL-ZP19', 'RM_402', 'Lucas', 'Meyer', 'lucas.meyer@example.com', '+49305550173', -3, 5, 2, 'breakfast,valet', 9041],
      ['HTL-MN42', 'RM_203', 'Mei', 'Chen', 'mei.chen@example.com', '+14155550222', 14, 2, 2, 'breakfast', 4477],
      ['HTL-CD34', 'RM_205', 'Marcus', 'Johnson', 'marcus.johnson@example.com', '+16285550199', 9, 3, 4, 'breakfast,valet', 1881],
      ['HTL-JP65', 'RM_303', 'Jonathan', 'Pierce', 'jonathan.pierce@example.com', '+14155550233', -1, 3, 1, '', 5151],
    ] as const;

    this.database.transaction(() => {
      for (const room of rooms) this.run('INSERT INTO hotel_rooms VALUES (?, ?, ?, ?, ?, ?, ?)', ...room);
      for (const table of tables) this.run('INSERT INTO restaurant_tables (label, capacity, location) VALUES (?, ?, ?)', ...table);
      for (const booking of bookings) {
        const [code, roomId, first, last, email, phone, offset, nights, guests, extrasText, last4] = booking;
        const checkIn = addDays(isoDate(seedDate), offset);
        const checkOut = addDays(checkIn, nights);
        const room = rooms.find((candidate) => candidate[0] === roomId)!;
        const extras = extrasText ? extrasText.split(',') as RoomExtra[] : [];
        const pricing = calculateStayTotal(room[2], nights, extras);
        this.run(`
          INSERT INTO hotel_bookings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NULL)
        `, code, roomId, first, last, email, phone, checkIn, checkOut, guests, extrasText,
        pricing.total, String(last4));
        this.upsertInvoice(code, room[2], nights, extras);
      }
      this.run(
        'INSERT INTO guest_history VALUES (?, ?)',
        'Lee',
        'Prefers a high quiet floor away from the elevator and feather-free pillows.',
      );
    }).immediate();
  }

  private run(sql: string, ...bindings: SQLQueryBindings[]) {
    return this.database.run(sql, bindings);
  }
}

export function reference(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}`;
}

function validateStay(checkIn: string, checkOut: string, guests: number, today: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    throw new Error('Check-in and check-out must use YYYY-MM-DD.');
  }
  if (checkIn < today) throw new Error('Check-in cannot be in the past.');
  if (checkOut <= checkIn) throw new Error('Check-out must be after check-in.');
  if (!Number.isInteger(guests) || guests < 1 || guests > 6) throw new Error('Guests must be between 1 and 6.');
}

function validateLast4(value: string) {
  if (!/^\d{4}$/.test(value)) throw new Error('Payment method must be represented by exactly four digits.');
}

function bookingFromRow(row: BookingRow): RoomBooking {
  return {
    code: row.code,
    roomId: row.room_id,
    roomType: row.room_type,
    roomView: row.room_view,
    nightlyRateCents: row.nightly_rate,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    checkIn: row.check_in,
    checkOut: row.check_out,
    guests: row.guests,
    extras: row.extras ? row.extras.split(',') as RoomExtra[] : [],
    totalCents: row.total,
    paymentMethodLast4: row.card_last4,
    status: row.status,
  };
}

function reservationFromRow(row: ReservationRow): RestaurantReservation {
  return {
    code: row.code,
    tableLabel: row.table_label,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    partySize: row.party_size,
    date: row.date,
    time: row.time,
    ...(row.notes ? { notes: row.notes } : {}),
    status: row.status,
  };
}

function invoiceFromRow(row: InvoiceRow): Invoice {
  return {
    bookingCode: row.booking_code,
    lineItems: JSON.parse(row.line_items) as Invoice['lineItems'],
    subtotalCents: row.subtotal,
    taxesCents: row.taxes,
    totalCents: row.total,
    paid: Boolean(row.paid),
  };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000);
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizeRoom(value: string): string {
  const room = value.trim().toUpperCase();
  return room.startsWith('RM_') ? room : `RM_${room}`;
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!local || !domain) return 'address on file';
  return `${local.slice(0, 1)}***@${domain}`;
}

function isDinnerTime(time: string): boolean {
  return /^\d{2}:\d{2}$/.test(time) && time >= '17:30' && time <= '21:00';
}
