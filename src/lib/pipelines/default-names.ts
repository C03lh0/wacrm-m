// ============================================================
// Display-time translation for the default pipeline/stage names.
//
// Pipeline and stage names are DB row content (seeded client-side in
// src/app/(dashboard)/pipelines/page.tsx when an account's first
// pipeline is created, and again whenever a user manually adds a new
// pipeline) — not UI chrome, so they can't be moved into next-intl
// message keys directly. Instead, this module does an exact-string
// match against the known English defaults and swaps in a translated
// label at render time; anything that doesn't match (a stage/pipeline
// a user renamed, or typed themselves) passes through unchanged.
//
// The seed code itself is untouched on purpose — it keeps writing the
// English defaults, so this lookup keeps working for both pre-existing
// and newly-seeded rows alike, with no migration required.
// ============================================================

const DEFAULT_STAGE_NAME_KEYS: Record<string, string> = {
  'New Lead': 'newLead',
  Qualified: 'qualified',
  'Proposal Sent': 'proposalSent',
  Negotiation: 'negotiation',
  Won: 'won',
};

const DEFAULT_PIPELINE_NAME_KEY = 'pipelineName';
const DEFAULT_PIPELINE_NAME = 'Sales Pipeline';

/**
 * Translate a stage name if it exactly matches one of the seeded
 * defaults; otherwise return it unchanged (a user-renamed stage).
 * `t` should already be scoped to `Pipelines.defaults` (e.g.
 * `useTranslations('Pipelines.defaults')`).
 */
export function translateDefaultStageName(
  name: string,
  t: (key: string) => string
): string {
  const key = DEFAULT_STAGE_NAME_KEYS[name];
  return key ? t(`stages.${key}`) : name;
}

/**
 * Translate a pipeline name if it exactly matches the seeded default
 * ("Sales Pipeline"); otherwise return it unchanged (a user-renamed or
 * manually-named pipeline). `t` should already be scoped to
 * `Pipelines.defaults`.
 */
export function translateDefaultPipelineName(
  name: string,
  t: (key: string) => string
): string {
  return name === DEFAULT_PIPELINE_NAME ? t(DEFAULT_PIPELINE_NAME_KEY) : name;
}
