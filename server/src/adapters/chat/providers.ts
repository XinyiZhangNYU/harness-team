import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { L, NoticeError, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import {
  CHAT_API_FORMATS,
  CHAT_MODEL_FIELD_NAMES,
  type ChatApiFormat,
  type ChatKeySource,
  type ChatModel,
  type ChatModelFields,
  type ChatProvider,
  type ChatProvidersResponse,
  type SaveChatModelRequest,
  type SaveChatProviderRequest,
} from '../../../../shared/protocol.ts';
import { listRate, localDate } from '../../pricing.ts';
import { CHAT_PRESETS, isVertexUrl, presetById, recommendedModel } from './catalog.ts';
import { headersProblem, mappingProblem, parseObject } from './body.ts';
import type { KeyFiles } from './secrets.ts';

/** A refusal with a message for the user (the API turns it into a 400/409). */
export class ChatConfigError extends NoticeError {
  readonly status: number;
  constructor(status: number, notice: NoticeText) {
    super(notice);
    this.status = status;
  }
}

type Row = Record<string, unknown>;

interface ProviderConfig {
  presetId?: string | null;
  vertexProject?: string | null;
  vertexLocation?: string | null;
  /** Last 4 characters of an app-stored key (shown in the UI; the key itself is only in <dataDir>/secrets). */
  keyHint?: string;
}

interface ModelConfig {
  /** Fields the user set by hand; everything else follows the recommendation. */
  fields?: Partial<ChatModelFields>;
}

const parse = <T>(v: unknown): T => {
  try {
    const o = JSON.parse(String(v ?? '{}'));
    return o && typeof o === 'object' ? o : ({} as T);
  } catch {
    return {} as T;
  }
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
const LIMITS = { context: [1_000, 10_000_000], output: [256, 2_000_000] } as const;

/** What a running chat turn needs: the provider, the model with its effective fields, and how to get the key. */
export interface ResolvedChatModel {
  provider: ChatProvider;
  model: ChatModel;
}

/**
 * Chat member providers and their models (tables `providers` / `provider_models`, schema v7 + v25). Keys are never in
 * the database: `key_ref` is "env:NAME", "app" (encrypted file) or "none".
 */
export class ChatProviders {
  private readonly db: DatabaseSync;
  private readonly keys: KeyFiles;

  constructor(db: DatabaseSync, keys: KeyFiles) {
    this.db = db;
    this.keys = keys;
    // The GLM preset was first called "智谱 GLM", which English UIs showed too; providers still named so follow it.
    db.prepare(`UPDATE providers SET label = 'GLM' WHERE chat = 1 AND label = '智谱 GLM' AND json_valid(config_json) AND json_extract(config_json, '$.presetId') = 'glm'`).run();
  }

  response(): ChatProvidersResponse {
    return { providers: this.list(), presets: CHAT_PRESETS, appKeys: !!this.keys.box };
  }

  list(): ChatProvider[] {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY created_at, id').all() as Row[];
    return rows.map((r) => this.toProvider(r));
  }

  get(id: string): ChatProvider | undefined {
    const r = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toProvider(r) : undefined;
  }

  private toProvider(r: Row): ChatProvider {
    const c = parse<ProviderConfig>(r.config_json);
    const legacy = Number(r.chat) !== 1;
    const format = (CHAT_API_FORMATS as readonly string[]).includes(String(r.format)) ? (r.format as ChatApiFormat) : 'openai_chat';
    const baseUrl = String(r.base_url);
    const id = String(r.id);
    const modelRows = this.db.prepare('SELECT * FROM provider_models WHERE provider_id = ? ORDER BY position, model_id').all(id) as Row[];
    return {
      id,
      label: String(r.label),
      presetId: c.presetId ?? null,
      format,
      baseUrl,
      key: legacy && String(r.key_ref) === 'app' ? { kind: 'none' } : keySource(String(r.key_ref), c.keyHint),
      vertexProject: c.vertexProject ?? null,
      vertexLocation: c.vertexLocation ?? null,
      enabled: Number(r.enabled) === 1,
      models: modelRows.map((m) => toModel(m, baseUrl, format)),
      legacy,
      createdAt: String(r.created_at),
    };
  }

  async create(req: SaveChatProviderRequest): Promise<ChatProvider> {
    const preset = req.presetId ? presetById(req.presetId) : undefined;
    if (req.presetId && !preset) throw new ChatConfigError(400, L('没有这个预设', 'No such preset'));
    const label = (req.label ?? preset?.label ?? '').trim();
    if (!label) throw new ChatConfigError(400, L('请填写名称', 'Enter a name'));
    const format = req.format ?? preset?.format;
    if (!format || !CHAT_API_FORMATS.includes(format)) throw new ChatConfigError(400, L('请选择 API 格式', 'Choose an API format'));
    const baseUrl = checkBaseUrl(req.baseUrl ?? preset?.baseUrl ?? '');
    const id = randomUUID();
    const config: ProviderConfig = { presetId: preset?.id ?? null, ...vertexFields(req, {}) };
    this.db
      .prepare(
        `INSERT INTO providers (id, label, format, billing, base_url, auth_header, key_ref, enabled, created_at, chat, config_json)
         VALUES (?, ?, ?, 'metered_api', ?, '', 'none', ?, ?, 1, ?)`,
      )
      .run(id, label.slice(0, 100), format, baseUrl, req.enabled === false ? 0 : 1, new Date().toISOString(), JSON.stringify(config));
    const add = this.db.prepare('INSERT INTO provider_models (provider_id, model_id, enabled, position, config_json) VALUES (?, ?, 1, ?, ?)');
    (preset?.models ?? []).forEach((m, i) => add.run(id, m, i, '{}'));
    try {
      if (req.key) await this.setKey(id, req.key);
    } catch (e) {
      this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
      throw e;
    }
    return this.get(id)!;
  }

  async update(id: string, req: SaveChatProviderRequest): Promise<ChatProvider> {
    const r = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ChatConfigError(404, L('供应商不存在', 'Provider not found'));
    const c = parse<ProviderConfig>(r.config_json);
    const label = req.label === undefined ? String(r.label) : req.label.trim();
    if (!label) throw new ChatConfigError(400, L('请填写名称', 'Enter a name'));
    if (req.format !== undefined && !CHAT_API_FORMATS.includes(req.format)) throw new ChatConfigError(400, L('请选择 API 格式', 'Choose an API format'));
    const format = req.format ?? String(r.format);
    const baseUrl = req.baseUrl === undefined ? String(r.base_url) : checkBaseUrl(req.baseUrl);
    // Only these keys are patched: keyHint belongs to setKey (json_patch drops nulls, read back as null).
    const config: ProviderConfig = { ...vertexFields(req, c) };
    if (req.presetId !== undefined) config.presetId = req.presetId;
    if (req.key) await this.setKey(id, req.key);
    // Saving a row left by the removed route makes it a chat provider (its format and key were just set again).
    this.db
      .prepare('UPDATE providers SET label = ?, format = ?, base_url = ?, enabled = ?, chat = 1, config_json = json_patch(config_json, ?) WHERE id = ?')
      .run(label.slice(0, 100), format, baseUrl, req.enabled === undefined ? Number(r.enabled) : req.enabled ? 1 : 0, JSON.stringify(config), id);
    return this.get(id)!;
  }

  private async setKey(id: string, key: NonNullable<SaveChatProviderRequest['key']>): Promise<void> {
    let ref = 'none';
    let hint: string | null = null;
    if (key.kind === 'env') {
      if (!ENV_NAME.test(key.name)) throw new ChatConfigError(400, L('环境变量名无效', 'Invalid environment variable name'));
      ref = `env:${key.name}`;
    } else if (key.kind === 'app') {
      const value = key.value.trim();
      if (!value || value.length > 4096 || /\s/.test(value)) throw new ChatConfigError(400, L('API Key 格式不正确', 'The API key is not valid'));
      if (!this.keys.box) {
        throw new ChatConfigError(400, L('只有桌面版能加密保存 Key；源码运行时请改用环境变量', 'Only the desktop app can store a key encrypted; when running from source use an environment variable'));
      }
      await this.keys.save(id, value);
      ref = 'app';
      hint = value.slice(-4);
    }
    if (ref !== 'app') this.keys.remove(id);
    this.db
      .prepare(`UPDATE providers SET key_ref = ?, config_json = json_set(config_json, '$.keyHint', ?) WHERE id = ?`)
      .run(ref, hint, id);
  }

  /** Environment variables that hold a provider's key (kept from the commands chat members run). */
  keyEnvNames(): string[] {
    const rows = this.db.prepare("SELECT key_ref FROM providers WHERE key_ref LIKE 'env:%'").all() as { key_ref: string }[];
    return rows.map((r) => String(r.key_ref).slice(4));
  }

  /** The key for a request, or null when none is set / the variable is empty. Never logged. */
  async key(id: string): Promise<string | null> {
    const r = this.db.prepare('SELECT key_ref, chat FROM providers WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const ref = String(r.key_ref);
    if (ref.startsWith('env:')) return process.env[ref.slice(4)]?.trim() || null;
    if (ref === 'app' && Number(r.chat) === 1) return this.keys.load(id);
    return null;
  }

  delete(id: string, inUse: string[]): void {
    if (inUse.length) {
      throw new ChatConfigError(
        409,
        L('还有成员在用这个供应商：{handles}。请先删除这些成员', 'Members still use this provider: {handles}. Delete them first', { handles: inUse.map((h) => `@${h}`).join(', ') }),
      );
    }
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM avatar_defaults WHERE runtime_kind = ?').run(`chat:${id}`);
    this.keys.remove(id);
  }

  addModel(providerId: string, modelId: string): ChatProvider {
    const p = this.get(providerId);
    if (!p) throw new ChatConfigError(404, L('供应商不存在', 'Provider not found'));
    const id = modelId.trim();
    if (!MODEL_ID.test(id)) throw new ChatConfigError(400, L('模型 ID「{id}」格式无效', 'The model id “{id}” is not valid', { id }));
    if (p.models.some((m) => m.id === id)) throw new ChatConfigError(409, L('模型「{id}」已在列表里', 'The model “{id}” is already in the list', { id }));
    const pos = Number((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM provider_models WHERE provider_id = ?').get(providerId) as Row).n);
    this.db.prepare('INSERT INTO provider_models (provider_id, model_id, enabled, position, config_json) VALUES (?, ?, 1, ?, ?)').run(providerId, id, pos, '{}');
    return this.get(providerId)!;
  }

  removeModel(providerId: string, modelId: string, inUse: string[]): ChatProvider {
    if (inUse.length) {
      throw new ChatConfigError(409, L('还有成员在用这个模型：{handles}', 'Members still use this model: {handles}', { handles: inUse.map((h) => `@${h}`).join(', ') }));
    }
    this.db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?').run(providerId, modelId);
    return this.get(providerId) ?? (() => { throw new ChatConfigError(404, L('供应商不存在', 'Provider not found')); })();
  }

  /** Sets fields by hand (they stop following the recommendation); a null field follows it again. */
  updateModel(providerId: string, modelId: string, req: SaveChatModelRequest): ChatProvider {
    const p = this.get(providerId);
    const m = p?.models.find((x) => x.id === modelId);
    if (!p || !m) throw new ChatConfigError(404, L('模型不存在', 'Model not found'));
    const row = this.db.prepare('SELECT config_json FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, modelId) as Row;
    const cfg = parse<ModelConfig>(row.config_json);
    const manual: Partial<ChatModelFields> = { ...(cfg.fields ?? {}) };
    for (const [k, v] of Object.entries(req.fields ?? {})) {
      if (!(CHAT_MODEL_FIELD_NAMES as readonly string[]).includes(k)) throw new ChatConfigError(400, L('未知字段：{k}', 'Unknown field: {k}', { k }));
      const key = k as keyof ChatModelFields;
      if (v === undefined) continue;
      if (v === null) delete manual[key];
      else (manual as Record<string, unknown>)[key] = checkField(key, v);
    }
    const effective = { ...m.recommended, ...manual };
    const problem = mappingProblem(effective.reasoningMapping, effective.reasoningLevels);
    if (problem) throw new ChatConfigError(400, L('推理参数映射：{p}', 'Reasoning mapping: {p}', { p: problem }));
    this.db
      .prepare('UPDATE provider_models SET enabled = ?, config_json = ? WHERE provider_id = ? AND model_id = ?')
      .run(effective.enabled ? 1 : 0, JSON.stringify({ ...cfg, fields: manual }), providerId, modelId);
    return this.get(providerId)!;
  }

  /** The provider and model a chat member calls, or why it cannot run now. */
  resolve(providerId: string | null, modelId: string | null): ResolvedChatModel | { error: Localized } {
    const provider = providerId ? this.get(providerId) : undefined;
    if (!provider) return { error: L('这个聊天成员的供应商已不存在', 'The provider of this chat member no longer exists') };
    if (provider.legacy) return { error: L('供应商「{p}」需要在设置里重新填写格式和 Key', 'The provider “{p}” needs its format and key again in Settings', { p: provider.label }) };
    if (!provider.enabled) return { error: L('供应商「{p}」已停用', 'The provider “{p}” is turned off', { p: provider.label }) };
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return { error: L('供应商「{p}」里没有模型「{m}」', 'The provider “{p}” has no model “{m}”', { p: provider.label, m: modelId ?? '' }) };
    if (!model.enabled) return { error: L('模型「{m}」已停用', 'The model “{m}” is turned off', { m: model.id }) };
    return { provider, model };
  }
}

function keySource(ref: string, hint: string | undefined): ChatKeySource {
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    return { kind: 'env', name, present: !!process.env[name]?.trim() };
  }
  if (ref === 'app') return { kind: 'app', hint: hint ?? '' };
  return { kind: 'none' };
}

function toModel(r: Row, baseUrl: string, format: ChatApiFormat): ChatModel {
  const id = String(r.model_id);
  const rec = recommendedModel(id, baseUrl, format);
  const cfg = parse<ModelConfig>(r.config_json);
  const manual: Partial<ChatModelFields> = {};
  // Rows of the removed route kept their own columns; they count as values set by hand.
  if (r.display_name != null && cfg.fields?.displayName === undefined) manual.displayName = String(r.display_name);
  if (r.context_tokens != null && cfg.fields?.contextTokens === undefined) manual.contextTokens = Number(r.context_tokens);
  for (const [k, v] of Object.entries(cfg.fields ?? {})) {
    if ((CHAT_MODEL_FIELD_NAMES as readonly string[]).includes(k)) (manual as Record<string, unknown>)[k] = v;
  }
  manual.enabled = Number(r.enabled) === 1;
  if (manual.enabled === rec.fields.enabled) delete manual.enabled;
  return {
    id,
    ...rec.fields,
    ...manual,
    recommended: rec.fields,
    manual: Object.keys(manual) as (keyof ChatModelFields)[],
    known: rec.known,
    listPrice: listRate('chat', id, localDate(), new Date()),
  };
}

function checkBaseUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ChatConfigError(400, L('Base URL 无效', 'The Base URL is not valid'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ChatConfigError(400, L('Base URL 必须以 https:// 或 http:// 开头', 'The Base URL must start with https:// or http://'));
  if (u.username || u.password) throw new ChatConfigError(400, L('Base URL 里不能带用户名或密码', 'The Base URL must not contain a user name or password'));
  if (u.search || u.hash) throw new ChatConfigError(400, L('Base URL 写到版本号为止，不带查询参数', 'Write the Base URL up to the version, without query parameters'));
  return v;
}

function vertexFields(req: SaveChatProviderRequest, cur: ProviderConfig): Pick<ProviderConfig, 'vertexProject' | 'vertexLocation'> {
  const clean = (v: string | null | undefined, re: RegExp, what: string) => {
    if (v === undefined) return undefined;
    const s = (v ?? '').trim();
    if (!s) return null;
    if (!re.test(s)) throw new ChatConfigError(400, L('{what}格式无效', '{what} is not valid', { what }));
    return s;
  };
  const project = clean(req.vertexProject, /^([a-z][a-z0-9-]{4,61}[a-z0-9]|\d{6,20})$/, 'Vertex project ID ');
  const location = clean(req.vertexLocation, /^[a-z0-9-]{2,40}$/, 'Vertex location ');
  return {
    vertexProject: project === undefined ? (cur.vertexProject ?? null) : project,
    vertexLocation: location === undefined ? (cur.vertexLocation ?? null) : location,
  };
}

function checkField(key: keyof ChatModelFields, v: unknown): unknown {
  const bad = () => new ChatConfigError(400, L('字段 {k} 的值无效', 'Invalid value for {k}', { k: key }));
  switch (key) {
    case 'displayName': {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s || s.length > 100) throw bad();
      return s;
    }
    case 'enabled':
    case 'image':
    case 'pdf':
    case 'tools':
    case 'webSearch':
    case 'explicitCache':
    case 'replayReasoning':
      if (typeof v !== 'boolean') throw bad();
      return v;
    case 'contextTokens':
    case 'maxOutputTokens': {
      const [min, max] = key === 'contextTokens' ? LIMITS.context : LIMITS.output;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad();
      return v;
    }
    case 'compactAt':
      if (typeof v !== 'number' || !(v >= 0.3 && v <= 0.95)) throw bad();
      return v;
    case 'reasoningLevels': {
      if (!Array.isArray(v) || v.length > 12) throw bad();
      const tags = v.map((x) => (typeof x === 'string' ? x.trim() : ''));
      if (tags.some((t) => !/^[\w.-]{1,40}$/.test(t)) || new Set(tags).size !== tags.length) throw bad();
      return tags;
    }
    case 'reasoningMapping':
    case 'extraBody':
    case 'extraHeaders': {
      if (typeof v !== 'string' || v.length > 20_000) throw bad();
      try {
        parseObject(v, key);
      } catch (e) {
        throw new ChatConfigError(400, L('{k}：{e}', '{k}: {e}', { k: key, e: (e as Error).message }));
      }
      if (key === 'extraHeaders') {
        const p = headersProblem(v);
        if (p) throw new ChatConfigError(400, L('{p}', '{p}', { p }));
      }
      return v;
    }
    case 'price': {
      const o = v as Record<string, unknown>;
      const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 10_000;
      if (!o || typeof o !== 'object' || !n(o.input) || !n(o.output) || !n(o.cacheRead) || !n(o.cacheWrite)) throw bad();
      return { input: o.input, output: o.output, cacheRead: o.cacheRead, cacheWrite: o.cacheWrite };
    }
  }
}

/** Whether a Gemini-format provider calls Vertex AI. */
export const providerIsVertex = (p: Pick<ChatProvider, 'format' | 'baseUrl'>) => p.format === 'gemini' && isVertexUrl(p.baseUrl);
