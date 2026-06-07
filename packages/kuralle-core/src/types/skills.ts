export interface SkillMeta {
  name: string;
  description: string;
}

export interface SkillLike {
  name: string;
  description: string;
  body: string;
  resources?: Record<string, string | Uint8Array>;
  allowedTools?: string[];
}

export interface SkillStoreLike {
  list(): Promise<SkillMeta[]>;
  loadBody(name: string): Promise<string>;
  loadResource(name: string, path: string): Promise<string | Uint8Array>;
  getAllSkills?(): SkillLike[] | Promise<SkillLike[]>;
  loadAllSkills?(): Promise<SkillLike[]>;
}

export type SkillSource = SkillLike | SkillLike[] | SkillStoreLike;
