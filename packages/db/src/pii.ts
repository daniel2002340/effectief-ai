// Personal data class of every column of every tenant table
// (docs/data-model.md §3.7). A test fails when a column is missing here.
//
// P  directly identifying (name, e-mail, phone, address)
// I  free content that may contain personal data (summary, mail text)
// V  derived from content (embedding)
// -  no personal data (ids, status, timestamps, amounts)

export type PiiClass = 'P' | 'I' | 'V' | '-';

const source = {
  source_type: '-',
  source_event_id: '-',
  source_user_id: '-',
  ai_model: '-',
  ai_trace_id: '-',
} as const;

export const piiRegister: Record<string, Record<string, PiiClass>> = {
  tenant_settings: {
    tenant_id: '-',
    default_vat_rate_bps: '-',
    content_retention_days: '-',
    created_at: '-',
    updated_at: '-',
  },
  entities: {
    id: '-',
    tenant_id: '-',
    type: '-',
    name: 'P',
    attributes: 'P',
    archived_at: '-',
    merged_into_id: '-',
    created_at: '-',
    updated_at: '-',
  },
  entity_identifiers: {
    id: '-',
    tenant_id: '-',
    entity_id: '-',
    kind: '-',
    value: 'P',
    ...source,
    created_at: '-',
  },
  relations: {
    id: '-',
    tenant_id: '-',
    from_entity_id: '-',
    to_entity_id: '-',
    type: '-',
    status: '-',
    valid_from: '-',
    valid_to: '-',
    confirmed_by_user_id: '-',
    confirmed_at: '-',
    ...source,
    created_at: '-',
    updated_at: '-',
  },
  events: {
    id: '-',
    tenant_id: '-',
    source: '-',
    external_id: '-',
    type: '-',
    occurred_at: '-',
    thread_key: '-',
    summary: 'I',
    summarized_at: '-',
    payload: '-',
    created_at: '-',
  },
  event_contents: {
    event_id: '-',
    tenant_id: '-',
    from_address: 'P',
    to_addresses: 'P',
    subject: 'I',
    body_text: 'I',
    attachments: 'I',
    retain_until: '-',
    created_at: '-',
  },
  event_entities: {
    tenant_id: '-',
    event_id: '-',
    entity_id: '-',
    role: '-',
    linked_by: '-',
    created_at: '-',
  },
  tasks: {
    id: '-',
    tenant_id: '-',
    title: 'I',
    notes: 'I',
    due_at: '-',
    status: '-',
    assignee_user_id: '-',
    created_by: '-',
    completed_at: '-',
    completed_by_user_id: '-',
    ...source,
    created_at: '-',
    updated_at: '-',
  },
  task_entities: {
    tenant_id: '-',
    task_id: '-',
    entity_id: '-',
    created_at: '-',
  },
};
