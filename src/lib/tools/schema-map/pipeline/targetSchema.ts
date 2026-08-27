export interface TargetSchema {
  nameField: string;
  codeField: string;
}

// Generic default, ported from topo-tools-py's bundled data/default.yaml.
export const DEFAULT_TARGET_SCHEMA: TargetSchema = {
  nameField: "adm{n}_name",
  codeField: "adm{n}_code",
};

export function validateTargetSchema(schema: TargetSchema): void {
  if (!schema.nameField.includes("{n}") || !schema.codeField.includes("{n}")) {
    throw new Error("Name and code templates must both contain a \"{n}\" placeholder.");
  }
}
