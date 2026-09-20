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
  /** How the agent asks about this field when nothing is recorded for it yet. */
  probe: string;
}

const FIELD_DEFINITIONS: Record<SopFieldName, FieldDefinition> = {
  purpose: {
    fieldClass: "blocking",
    label: "Purpose",
    description: "Why the process exists and what it controls.",
    probe: "What is the intended outcome of this process, and why does it exist?",
  },
  scope: {
    fieldClass: "blocking",
    label: "Scope",
    description: "What the process covers, and explicitly what it does not.",
    probe: "Which situations does this process cover, and which does it explicitly not cover?",
  },
  trigger: {
    fieldClass: "blocking",
    label: "Trigger",
    description: "What starts the process.",
    probe: "What event starts this process?",
  },
  roles: {
    fieldClass: "blocking",
    label: "Roles",
    description: "Who executes, who decides, and who approves.",
    probe: "Who carries out the work, who decides, and who approves?",
  },
  procedure: {
    fieldClass: "blocking",
    label: "Procedure",
    description: "The standard steps, one claim per step.",
    probe: "What are the steps, in order, from start to finish?",
  },
  authorization: {
    fieldClass: "blocking",
    label: "Authorization",
    description:
      "When a person cannot decide alone, and who decides instead, such as amount thresholds.",
    probe: "When can someone not decide alone, and who decides instead? Are there amount limits?",
  },
  completionCriteria: {
    fieldClass: "blocking",
    label: "Completion criteria",
    description: "What counts as done.",
    probe: "How do you know the process is finished?",
  },
  governance: {
    fieldClass: "blocking",
    label: "Governance",
    description: "Who may change the SOP and how changes are reviewed.",
    probe: "Who can change this procedure, and how are changes reviewed?",
  },
  exceptions: {
    fieldClass: "advisory",
    label: "Exceptions",
    description: "What happens when something breaks or does not fit.",
    probe: "Where does this process usually go wrong, and what happens then?",
  },
  evidence: {
    fieldClass: "advisory",
    label: "Evidence",
    description: "What must be recorded to show what happened and why.",
    probe: "What has to be recorded to show what happened and why?",
  },
  controls: {
    fieldClass: "advisory",
    label: "Controls",
    description: "How compliance with the process is checked, such as audits or sampling.",
    probe: "How do you check that people follow the process?",
  },
  decisionRules: {
    fieldClass: "advisory",
    label: "Decision rules",
    description: "How different conditions change the path.",
    probe: "Which conditions change what happens next?",
  },
  prerequisites: {
    fieldClass: "advisory",
    label: "Prerequisites",
    description: "What must hold before the process starts.",
    probe: "What must be true before the process can start?",
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
