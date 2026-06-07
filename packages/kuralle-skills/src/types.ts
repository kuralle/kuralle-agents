export interface Skill {
  name: string;
  description: string;
  body: string;
  resources?: Record<string, string | Uint8Array>;
  allowedTools?: string[];
}

export interface SkillMeta {
  name: string;
  description: string;
}

export type SkillSource = Skill | Skill[] | SkillStore;

export interface SkillStore {
  list(): Promise<SkillMeta[]>;
  loadBody(name: string): Promise<string>;
  loadResource(name: string, path: string): Promise<string | Uint8Array>;
}
