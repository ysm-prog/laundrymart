/**
 * Row shapes for the queries this app actually runs.
 *
 * Hand-written rather than generated so the repo builds without a live project.
 * Once a Supabase project is connected, `supabase gen types typescript` can
 * replace this file wholesale — the query call sites use `.returns<T>()` so the
 * swap is a one-line change per query.
 */

export type Uuid = string;

export type Depot = {
  id: Uuid;
  code: string;
  name: string;
  suburb: string | null;
  state: string | null;
  timezone: string;
  contact_name: string | null;
  contact_phone: string | null;
  status: string;
};

export type Customer = {
  id: Uuid;
  customer_number: string;
  business_name: string;
  trading_name: string | null;
  abn: string | null;
  billing_address_line1: string | null;
  billing_suburb: string | null;
  billing_state: string | null;
  billing_postcode: string | null;
  billing_email: string | null;
  phone: string | null;
  payment_terms_days: number;
  purchase_order_number: string | null;
  special_instructions: string | null;
  notes: string | null;
  status: string;
  depot_id: Uuid | null;
  created_at: string;
  /** 0014 — what they owed when the books were carried across, not a live figure. */
  opening_balance?: number;
  opening_balance_overdue?: number;
  /** 0014 — whether this customer is in the overdue chase at all. */
  reminders_enabled?: boolean;
};

export type CustomerLocation = {
  id: Uuid;
  customer_id: Uuid;
  name: string;
  address_line1: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  access_notes: string | null;
  is_pickup: boolean;
  is_delivery: boolean;
  is_primary: boolean;
  status: string;
};

export type CustomerContact = {
  id: Uuid;
  customer_id: Uuid;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
};

/**
 * The item master (0002, extended into one by 0032).
 *
 * One vocabulary: what the laundry rents out *and* what arrives in a customer's
 * bag, carrying the code the business already uses in its books.
 */
export type Item = {
  id: Uuid;
  sku: string;
  /**
   * The code staff actually know — TOW001 — from MYOB where there is one.
   * Backfilled from `sku` by 0032 and free to diverge from it afterwards.
   */
  item_code: string | null;
  name: string;
  description: string | null;
  category: string;
  /**
   * Which of the nine kinds of laundry this is, or null for something a
   * customer never hands over. The bridge that lets a job name an item while
   * every existing price tier keeps matching on `item_type`.
   */
  laundry_category: string | null;
  ownership_type: string;
  /** MYOB's "Item I Sell" / "Item I Buy". Both, neither and either are real. */
  is_sell: boolean;
  is_buy: boolean;
  sell_price: number;
  cost_price: number;
  /** The ledger's tax code (GST, FRE, …). Somebody else's vocabulary, so a string. */
  tax_code: string | null;
  replacement_cost: number;
  rental_price: number;
  wash_only_price: number;
  weight_kg: number;
  reorder_level: number;
  myob_item_id: string | null;
  myob_item_code: string | null;
  /** When this row last agreed with the external ledger. Null until something syncs. */
  external_synced_at: string | null;
  status: string;
};

export type Vehicle = {
  id: Uuid;
  registration: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  vehicle_type: string;
  capacity_kg: number | null;
  fuel_type: string | null;
  maintenance_status: string;
  next_service_date: string | null;
  depot_id: Uuid | null;
  status: string;
};

export type Driver = {
  id: Uuid;
  full_name: string;
  employee_number: string | null;
  email: string | null;
  phone: string | null;
  licence_number: string | null;
  licence_expiry: string | null;
  depot_id: Uuid | null;
  user_id: Uuid | null;
  status: string;
};

export type ServiceAgreement = {
  id: Uuid;
  customer_id: Uuid;
  location_id: Uuid | null;
  agreement_number: string;
  version: number;
  status: string;
  start_date: string;
  end_date: string | null;
  pickup_pattern: unknown;
  delivery_pattern: unknown;
  collections_per_visit: number;
  emergency_service: boolean;
  linen_ownership: string;
  minimum_charge: number;
  holiday_rule: string;
  holiday_region: string;
  weekend_surcharge_pct: number;
  holiday_surcharge_pct: number;
  fuel_levy_pct: number;
  billing_frequency: string;
  payment_terms_days: number;
  purchase_order_number: string | null;
  notes: string | null;
};

export type ServiceAgreementLine = {
  id: Uuid;
  agreement_id: Uuid;
  item_id: Uuid | null;
  charge_type: string;
  pricing_model: string;
  unit_price: number;
  percentage: number | null;
  standard_quantity: number;
  included_quantity: number;
  taxable: boolean;
};

export type RouteTemplate = {
  id: Uuid;
  code: string;
  name: string;
  description: string | null;
  weekdays: number[];
  depot_id: Uuid | null;
  default_driver_id: Uuid | null;
  default_vehicle_id: Uuid | null;
  planned_start_time: string | null;
  status: string;
};

export type RouteTemplateStop = {
  id: Uuid;
  template_id: Uuid;
  customer_id: Uuid;
  location_id: Uuid | null;
  sequence: number;
  service_type: string;
  planned_arrival: string | null;
  service_minutes: number;
  notes: string | null;
};

/**
 * A standing delivery round with its own login (migration 0031).
 *
 * The assignment target. A `drivers` row remains the record of a *person*, and
 * `daily_routes.operated_by_driver_id` is where "who drove this round today"
 * lives — which is the whole reason both tables exist.
 */
export type Board = {
  id: Uuid;
  code: string;
  name: string;
  user_id: Uuid | null;
  depot_id: Uuid | null;
  default_vehicle_id: Uuid | null;
  notes: string | null;
  status: string;
};

export type DailyRoute = {
  id: Uuid;
  route_date: string;
  code: string;
  name: string;
  status: string;
  /** The round this run belongs to (migration 0031). */
  board_id: Uuid | null;
  /**
   * Pre-0031 runs only. A run is a board's now; this is kept so a historical
   * one still reads correctly and is no longer written.
   */
  driver_id: Uuid | null;
  /** Who actually drove this round on this day. Recorded for accountability. */
  operated_by_driver_id: Uuid | null;
  vehicle_id: Uuid | null;
  depot_id: Uuid | null;
  template_id: Uuid | null;
  inspection_id: Uuid | null;
  load_confirmed_at: string | null;
  started_at: string | null;
  returned_at: string | null;
  unloaded_at: string | null;
  closed_at: string | null;
  odometer_start_km: number | null;
  odometer_end_km: number | null;
  notes: string | null;
};

export type Job = {
  id: Uuid;
  job_number: string;
  scheduled_date: string;
  sequence: number;
  service_type: string;
  status: string;
  progress_status: string;
  customer_id: Uuid;
  location_id: Uuid | null;
  route_id: Uuid | null;
  driver_id: Uuid | null;
  agreement_id: Uuid | null;
  arrived_at: string | null;
  completed_at: string | null;
  exception_reason: string | null;
  exception_notes: string | null;
  notes: string | null;
};

export type Pickup = {
  id: Uuid;
  job_id: Uuid;
  customer_id: Uuid;
  pickup_date: string;
  bag_count: number;
  total_weight_kg: number | null;
  notes: string | null;
  signed_by: string | null;
  /** Storage keys in the private `run-media` bucket, not public URLs. */
  photo_urls: string[];
  signature_url: string | null;
  completed_at: string | null;
};

export type PickupLine = {
  id: Uuid;
  pickup_id: Uuid;
  item_id: Uuid;
  quantity: number;
  damaged_quantity: number;
  missing_quantity: number;
  notes: string | null;
};

export type Delivery = {
  id: Uuid;
  job_id: Uuid;
  customer_id: Uuid;
  delivery_date: string;
  notes: string | null;
  signed_by: string | null;
  /** Storage keys in the private `run-media` bucket, not public URLs. */
  photo_urls: string[];
  signature_url: string | null;
  completed_at: string | null;
};

export type DeliveryLine = {
  id: Uuid;
  delivery_id: Uuid;
  item_id: Uuid;
  quantity: number;
  notes: string | null;
};

export type InventoryPool = {
  id: Uuid;
  item_id: Uuid;
  owner_type: string;
  state: string;
  customer_id: Uuid | null;
  depot_id: Uuid | null;
  vehicle_id: Uuid | null;
  quantity: number;
  reorder_level: number;
};

export type InventoryMovement = {
  id: Uuid;
  item_id: Uuid;
  owner_type: string;
  quantity: number;
  from_state: string | null;
  to_state: string | null;
  reason: string;
  notes: string | null;
  occurred_at: string;
};

export type Invoice = {
  id: Uuid;
  invoice_number: string;
  customer_id: Uuid;
  invoice_type: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  purchase_order_number: string | null;
  payment_terms_days: number;
  subtotal: number;
  tax_amount: number;
  total: number;
  amount_paid: number;
  balance: number;
  notes: string | null;
  emailed_at: string | null;
  /** Address the PDF was last sent to, stamped at send time. */
  emailed_to: string | null;
};

export type InvoiceLine = {
  id: Uuid;
  invoice_id: Uuid;
  description: string;
  charge_type: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
  sequence: number;
};

export type Payment = {
  id: Uuid;
  invoice_id: Uuid | null;
  customer_id: Uuid;
  paid_on: string;
  amount: number;
  method: string;
  reference: string | null;
};

export type AuditLog = {
  id: Uuid;
  entity: string;
  entity_id: Uuid | null;
  action: string;
  summary: string | null;
  created_at: string;
  actor_id: Uuid | null;
};

export type PublicHoliday = {
  id: Uuid;
  holiday_date: string;
  name: string;
  region: string;
};

export type Membership = {
  user_id: Uuid;
  role: string;
  depot_id: Uuid | null;
  created_at: string;
};

/** Spec §7.16 — a grouping of linen moving through the plant together. */
export type ProductionBatch = {
  id: Uuid;
  depot_id: Uuid | null;
  /** The run this batch was counted off, when it came from one. */
  route_id: Uuid | null;
  batch_number: string;
  stage: string;
  machine: string | null;
  operator_id: Uuid | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  created_at: string;
};

export type ProductionBatchLine = {
  id: Uuid;
  batch_id: Uuid;
  item_id: Uuid;
  owner_type: "laundry_owned" | "customer_owned";
  customer_id: Uuid | null;
  /** What the warehouse counted onto the floor. */
  quantity: number;
  /** What the driver booked out of the customers, when counted off a run. */
  driver_quantity: number | null;
  rejected_quantity: number;
  notes: string | null;
};

/**
 * A laundry job (migration 0014) — the counter's order, not the routing module's
 * stop. `Job` above is the stop; this is the customer's laundry from drop-off to
 * hand-back. The schema calls it a laundry order, the UI calls it a Job.
 */
export type LaundryOrder = {
  id: Uuid;
  tenant_id: Uuid;
  depot_id: Uuid | null;
  customer_id: Uuid;
  order_number: string;
  status: string;
  priority: string;
  received_at: string;
  received_via: string;
  pickup_date: string | null;
  /**
   * **Legacy, and out of the workflow.** Nothing reads or writes this any more:
   * it is not on the create or edit form, not in the action's schema and not on
   * any screen. The column and its historical values are kept deliberately
   * rather than dropped in a destructive migration — see the 2026-08-14 entry.
   */
  pickup_time: string | null;
  pickup_driver_id: Uuid | null;
  delivery_required: boolean;
  expected_delivery_date: string | null;
  expected_collection_date: string | null;
  delivery_window: string | null;
  expected_delivery_time: string | null;
  delivery_address_source: string;
  /** Snapshot taken when the job was written. Never refreshed from the customer. */
  delivery_address: string | null;
  delivery_instructions: string | null;
  special_instructions: string | null;
  assigned_to: Uuid | null;
  created_by: Uuid | null;
  delivered_at: string | null;
  delivered_by: Uuid | null;
  collected_at: string | null;
  collected_by: Uuid | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string | null;
  /** Generated: the delivery date, or the collection date for a pickup job. */
  due_date: string | null;
  /**
   * The stop on a board's run that carries this job (migration 0015).
   *
   * The *operational* placement: which visit on which run, for the depot load,
   * the run sheet and the inventory sweep. Since 0016 it is no longer where the
   * assignment is read from — `assigned_board_id` and `assigned_delivery_date`
   * below are — and `guard_laundry_order_assignment()` keeps the two from
   * disagreeing. Null means the job is on nobody's run.
   */
  stop_id: Uuid | null;

  /**
   * Which round is delivering this job, and on which Adelaide day (0016, moved
   * to boards by 0031).
   *
   * The user-facing assignment, and the pair My Runs queries on. Both are set
   * together or neither is: a check constraint refuses half an assignment, and
   * another refuses status `assigned` without them.
   */
  assigned_board_id: Uuid | null;
  /**
   * The pre-0031 assignment. Historical jobs keep it and read correctly; the
   * app no longer writes it, and the assignment guard refuses a new one.
   */
  assigned_driver_id: Uuid | null;
  assigned_delivery_date: string | null;
  assigned_at: string | null;
  assigned_by: Uuid | null;

  /** When the round confirmed this job was on the van, and who confirmed it. */
  load_confirmed_at: string | null;
  load_confirmed_by: Uuid | null;

  /**
   * The job's *financial* state, beside the operational one (migration 0017).
   *
   * `pending → awaiting_review → approved → invoice_generated → invoice_sent
   * → paid`, plus `not_billable`. Completing a job sets `awaiting_review` in the
   * transition guard and **never generates an invoice** — everything past that
   * point is a finance decision. See `src/lib/domain/billing.ts`.
   */
  billing_status: string;
  billing_approved_at: string | null;
  billing_approved_by: Uuid | null;
  /** Why this job is out of the billing queue. Required unless it was cancelled. */
  billing_exclusion_reason: string | null;
};

export type LaundryOrderItem = {
  id: Uuid;
  order_id: Uuid;
  /**
   * The item master row this is (0032), where the counter picked a coded item.
   *
   * Null on every job written before the item master. When it is set,
   * `item_type` is derived from the item by a trigger, so the two cannot
   * disagree — which is what keeps every existing price tier and report working.
   */
  item_id: Uuid | null;
  item_type: string;
  custom_description: string | null;
  quantity_type: string;
  exact_quantity: number | null;
  bag_count: number | null;
  estimated_quantity: number | null;
  notes: string | null;
};

export type LaundryOrderActivity = {
  id: Uuid;
  order_id: Uuid;
  actor_id: Uuid | null;
  activity_type: string;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  note: string | null;
  created_at: string;
};

/** 0021 — the payable side of the books (renumbered from 0014). */
export type Supplier = {
  id: Uuid;
  supplier_number: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** Balance carried in from the previous system, not a running total. */
  opening_balance: number;
  notes: string | null;
  status: string;
};

export type SupplierBill = {
  id: Uuid;
  supplier_id: Uuid;
  bill_number: string;
  supplier_invoice_no: string | null;
  issue_date: string;
  due_date: string | null;
  amount: number;
  /** Legitimately negative: a supplier debit note is money owed back to us. */
  balance_due: number;
  status: string;
  suppliers: { name: string } | null;
};

export type PurchaseOrder = {
  id: Uuid;
  supplier_id: Uuid;
  po_number: string;
  supplier_invoice_no: string | null;
  issue_date: string;
  promised_date: string | null;
  amount: number;
  balance_due: number;
  status: string;
  suppliers: { name: string } | null;
};

export type GlAccount = {
  id: Uuid;
  code: string;
  name: string;
  account_type: string;
  tax_code: string | null;
  is_linked: boolean;
  /** True for the six MYOB classification rows that carry no code of their own. */
  is_header: boolean;
  level: number;
  current_balance: number;
};

/** 0015 — a payment that left the business, one per remittance advice. */
export type SupplierPayment = {
  id: Uuid;
  supplier_id: Uuid;
  reference: string;
  paid_on: string;
  amount: number;
  remittance_email: string | null;
  suppliers: { name: string } | null;
};

/** `select("id, name")` on a lookup table. */
export type Option = { id: Uuid; name: string };
