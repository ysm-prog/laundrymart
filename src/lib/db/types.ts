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

export type Item = {
  id: Uuid;
  sku: string;
  name: string;
  category: string;
  ownership_type: string;
  replacement_cost: number;
  rental_price: number;
  wash_only_price: number;
  weight_kg: number;
  reorder_level: number;
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

export type DailyRoute = {
  id: Uuid;
  route_date: string;
  code: string;
  name: string;
  status: string;
  driver_id: Uuid | null;
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

/** `select("id, name")` on a lookup table. */
export type Option = { id: Uuid; name: string };
