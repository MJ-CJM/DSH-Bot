import { isDeepStrictEqual } from 'node:util';
import Schema from '@deepseek-ai/schemastery';
import { BOT_ID_PATTERN } from '../../shared/ids.js';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };

export interface SupergroupConfig {
  enabled: boolean;
  maxMembers: number;
  maxExperts: number;
  maxRequests: number;
  timeoutMs: number;
  allowedBotIds: string[];
  taskMaterialMaxCount: number;
  taskMaterialMaxChars: number;
  taskMaterialMaxTotalChars: number;
}
const integer = (minimum: number, maximum: number, fallback: number) => Schema.transform(
  Schema.number().min(minimum).max(maximum), value => {
    if (!Number.isSafeInteger(value)) throw new TypeError('Supergroup limits must be safe integers');
    return value;
  }).default(fallback);
export const Config: Schema<Partial<SupergroupConfig>, SupergroupConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  taskMaterialMaxCount: integer(1, 8, 8),
  taskMaterialMaxChars: integer(256, 16384, 16384),
  taskMaterialMaxTotalChars: integer(256, 49152, 49152),
  maxMembers: integer(2, 16, 4),
  maxExperts: integer(1, 64, 16),
  maxRequests: integer(1, 256, 24),
  timeoutMs: integer(1000, 3600000, 300000),
  allowedBotIds: Schema.transform(Schema.array(Schema.string().pattern(BOT_ID_PATTERN)), value => {
    if (value.length > 64 || new Set(value).size !== value.length) throw new TypeError('Supergroup Bot IDs must be unique, with at most 64 entries');
    return value;
  }).default([]),
}).i18n({ en: en.config.supergroup, zh: zh.config.supergroup });

/** Only this narrow change is safe for the stable Host's live mode update. */
export function onlySupergroupChanged(previous: object, next: object): boolean {
  return !isDeepStrictEqual(Reflect.get(previous, 'supergroup'), Reflect.get(next, 'supergroup'))
    && [...new Set([...Object.keys(previous), ...Object.keys(next)])].every(key => key === 'supergroup'
    || isDeepStrictEqual(Reflect.get(previous, key), Reflect.get(next, key)));
}
