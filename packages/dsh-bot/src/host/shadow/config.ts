import Schema from '@deepseek-ai/schemastery';
export interface ShadowConfig {
  shadowEnabled: boolean;
  offlineOrganizeEnabled: boolean;
  shadowDomainDaily: number;
  shadowBotDaily: number;
}
const daily = (fallback: number) => Schema.transform(Schema.number(), value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw Error('Invalid shadow daily limit');
  return value;
}).default(fallback);
export const shadowConfigFields = {
  shadowEnabled: Schema.boolean().default(false),
  offlineOrganizeEnabled: Schema.boolean().default(false),
  shadowDomainDaily: daily(20), shadowBotDaily: daily(5),
};
