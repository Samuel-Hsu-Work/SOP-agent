/**
 * The 13 fields of an SOP, declared blocking-first. That single order drives the readiness panel
 * and the agent's "blocking gaps first" behavior, so nothing needs sorting anywhere.
 */
export const SOP_FIELD_NAMES = [
  "purpose",
  "scope",
  "trigger",
  "roles",
  "procedure",
  "authorization",
  "completionCriteria",
  "governance",
  "exceptions",
  "evidence",
  "controls",
  "decisionRules",
  "prerequisites",
] as const;

export type SopFieldName = (typeof SOP_FIELD_NAMES)[number];

/** Fixed for v1. Nothing can change a field's class or escalate an advisory gap to blocking. */
export type FieldClass = "blocking" | "advisory";

interface FieldDefinition {
  fieldClass: FieldClass;
  label: string;
  description: string;
}

const FIELD_DEFINITIONS: Record<SopFieldName, FieldDefinition> = {
  purpose: {
    fieldClass: "blocking",
    label: "Purpose",
    description: "Why the process exists and what it controls.",
  },
  scope: {
    fieldClass: "blocking",
    label: "Scope",
    description: "What the process covers, and explicitly what it does not.",
  },
  trigger: {
    fieldClass: "blocking",
    label: "Trigger",
    description: "What starts the process.",
  },
  roles: {
    fieldClass: "blocking",
    label: "Roles",
    description: "Who executes, who decides, and who approves.",
  },
  procedure: {
    fieldClass: "blocking",
    label: "Procedure",
    description: "The standard steps, one claim per step.",
  },
  authorization: {
    fieldClass: "blocking",
    label: "Authorization",
    description:
      "When a person cannot decide alone, and who decides instead, such as amount thresholds.",
  },
  completionCriteria: {
    fieldClass: "blocking",
    label: "Completion criteria",
    description: "What counts as done.",
  },
  governance: {
    fieldClass: "blocking",
    label: "Governance",
    description: "Who may change the SOP and how changes are reviewed.",
  },
  exceptions: {
    fieldClass: "advisory",
    label: "Exceptions",
    description: "What happens when something breaks or does not fit.",
  },
  evidence: {
    fieldClass: "advisory",
    label: "Evidence",
    description: "What must be recorded to show what happened and why.",
  },
  controls: {
    fieldClass: "advisory",
    label: "Controls",
    description: "How compliance with the process is checked, such as audits or sampling.",
  },
  decisionRules: {
    fieldClass: "advisory",
    label: "Decision rules",
    description: "How different conditions change the path.",
  },
  prerequisites: {
    fieldClass: "advisory",
    label: "Prerequisites",
    description: "What must hold before the process starts.",
  },
};

export interface SopField extends FieldDefinition {
  name: SopFieldName;
}

export const SOP_FIELDS: readonly SopField[] = SOP_FIELD_NAMES.map((name) => ({
  name,
  ...FIELD_DEFINITIONS[name],
}));

export function getFieldDefinition(field: SopFieldName): SopField {
  return { name: field, ...FIELD_DEFINITIONS[field] };
}

export function getFieldClass(field: SopFieldName): FieldClass {
  return FIELD_DEFINITIONS[field].fieldClass;
}
