/** Diagnostics never retain credentials, response bodies, URLs or transport causes. */
export class AvailKitError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly kind: 'api' | 'transport' | 'protocol' | 'input';
  readonly outcome: 'not_sent' | 'rejected' | 'unknown';
  constructor(kind: AvailKitError['kind'], code: string, status?: number) {
    super(`AvailKit ${kind} error (${status ?? code})`);
    this.name = 'AvailKitError';
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.outcome = kind === 'input' ? 'not_sent' : kind === 'api' && status !== undefined && status >= 400 && status < 500 && code !== 'api_error' ? 'rejected' : 'unknown';
  }
}


export const safeErrorCodes = new Set(["booking_page_paused", "booking_access_in_use", "contact_changed", "validation_failed", "synthetic_email_required", "unauthorized", "forbidden", "scope_denied", "not_found", "invalid_input", "invalid_query", "invalid_cursor", "invalid_limit", "quota_exceeded", "unavailable", "credential_invalid", "capability_denied", "customer_archived", "idempotency_conflict", "capacity_conflict", "capacity_exceeded", "version_conflict", "catalog_in_use", "catalog_archived", "event_cursor_expired", "invalid_id", "invalid_range", "identity_unavailable", "recovery_unavailable", "csrf_invalid", "recent_auth_required", "secret_already_revealed", "idempotency_mismatch", "membership_changed", "membership_denied", "last_credential", "identity_limit", "identity_rate_limited", "membership_conflict", "request_key_invalid"]);
