import Schema from '@deepseek-ai/schemastery';

export interface Config {
  k1: number;
  bodyB: number;
  fieldB: number;
  factKeyWeight: number;
  qualifierWeight: number;
  subjectWeight: number;
  minCoverage: number;
  diversityPenalty: number;
  diversityThreshold: number;
  diversityWindow: number;
}
const baseConfig = Schema.object({
  k1: Schema.number().min(0.1).max(4).default(1.2),
  bodyB: Schema.number().min(0).max(1).default(0.15),
  fieldB: Schema.number().min(0).max(1).default(0.75),
  factKeyWeight: Schema.number().min(0).max(10).default(2.5),
  qualifierWeight: Schema.number().min(0).max(10).default(1.5),
  subjectWeight: Schema.number().min(0).max(10).default(0.3),
  minCoverage: Schema.number().min(0.01).max(1).default(0.51),
  diversityPenalty: Schema.number().min(0).max(1).default(0.6),
  diversityThreshold: Schema.number().min(0.5).max(1).default(0.8),
  diversityWindow: Schema.number().step(1).min(5).max(200).default(50),
});
export const Config: Schema<Partial<Config>, Config> = baseConfig.default(baseConfig({}) as Config);
export const defaultRetrievalConfig: Readonly<Config> = Object.freeze(Config({}));
