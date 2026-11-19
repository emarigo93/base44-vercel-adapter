// Entidades de Base44 guardadas en PostgreSQL (Neon, Supabase o cualquier Postgres).
// Todas las entidades viven en una sola tabla con una columna JSONB, así una entidad nueva
// creada en el editor de Base44 funciona sin migraciones.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import SCHEMAS from "virtual:b44-entities";
import { Base44Error } from "./errors.js";
import { applyUpdateOps, compareValues, matches } from "./query.js";

const TABLE = "b44_entities";
const SYSTEM_COLUMNS = new Set(["id", "created_date", "updated_date", "created_by", "created_by_id"]);
const DATE_COLUMNS = new Set(["created_date", "updated_date"]);
const MAX_ROWS = 10000;
const MAX_AGGREGATE_ROWS = 1000;

let client;
let ready;

export function sql() {
  if (!client) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Base44Error("Falta DATABASE_URL (o POSTGRES_URL) en las variables de entorno.", 500, "CONFIG");
    client = postgres(url, { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
  }
  return client;
}

// Crea la tabla la primera vez que se usa. No hace falta correr migraciones.
async function db() {
  const s = sql();
  ready ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await s.unsafe(`
          CREATE TABLE IF NOT EXISTS ${TABLE} (
            entity        text        NOT NULL,
            id            text        NOT NULL,
            data          jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_date  timestamptz NOT NULL DEFAULT now(),
            updated_date  timestamptz NOT NULL DEFAULT now(),
            created_by    text,
            created_by_id text,
            PRIMARY KEY (entity, id)
          );
          CREATE INDEX IF NOT EXISTS ${TABLE}_created_idx ON ${TABLE} (entity, created_date DESC);
          CREATE INDEX IF NOT EXISTS ${TABLE}_data_idx ON ${TABLE} USING gin (data jsonb_path_ops);
        `);
        return;
      } catch (error) {
        // Dos arranques en paralelo pueden chocar creando la tabla; el segundo intento la encuentra.
        if (attempt === 1) throw error;
      }
    }
  })().catch((error) => {
    ready = undefined;
    throw error;
  });
  await ready;
  return s;
}

export function newId() {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, "0") + randomBytes(8).toString("hex");
}

function toRecord(row) {
  return {
    ...row.data,
    id: row.id,
    created_date: row.created_date instanceof Date ? row.created_date.toISOString() : row.created_date,
    updated_date: row.updated_date instanceof Date ? row.updated_date.toISOString() : row.updated_date,
    created_by: row.created_by ?? null,
    created_by_id: row.created_by_id ?? null,
  };
}

function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

// Separa los campos del sistema (columnas) de los datos de la entidad (JSONB).
function splitData(input) {
  const data = {};
  for (const [key, value] of Object.entries(normalize(input || {}))) {
    if (SYSTEM_COLUMNS.has(key) || key === "is_sample" || value === undefined) continue;
    data[key] = value;
  }
  return data;
}

function withDefaults(entity, data) {
  const properties = SCHEMAS[entity]?.properties || {};
  const out = { ...data };
  for (const [key, prop] of Object.entries(properties)) {
    if (out[key] === undefined && prop && prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

// ---------- traducción de filtros estilo Base44/MongoDB a SQL ----------

function join(s, parts, separator) {
  return parts.reduce((acc, part, i) => (i === 0 ? part : separator === "AND" ? s`${acc} AND ${part}` : separator === "OR" ? s`${acc} OR ${part}` : s`${acc}, ${part}`), undefined);
}

function jsonPath(s, field) {
  const path = field.split(".");
  return path.length === 1 ? s`(data -> ${path[0]})` : s`(data #> ${"{" + path.join(",") + "}"}::text[])`;
}

function columnCondition(s, field, op, value) {
  const col = s(field);
  const cast = (v) => (DATE_COLUMNS.has(field) ? s`${String(v)}::timestamptz` : s`${v === null ? null : String(v)}`);
  switch (op) {
    case "$eq":
      return value === null ? s`${col} IS NULL` : s`${col} = ${cast(value)}`;
    case "$ne":
      return value === null ? s`${col} IS NOT NULL` : s`(${col} IS NULL OR ${col} <> ${cast(value)})`;
    case "$gt":
      return s`${col} > ${cast(value)}`;
    case "$gte":
      return s`${col} >= ${cast(value)}`;
    case "$lt":
      return s`${col} < ${cast(value)}`;
    case "$lte":
      return s`${col} <= ${cast(value)}`;
    case "$in":
      return value.length ? s`(${join(s, value.map((v) => columnCondition(s, field, "$eq", v)), "OR")})` : s`FALSE`;
    case "$nin":
      return value.length ? s`NOT (${join(s, value.map((v) => columnCondition(s, field, "$eq", v)), "OR")})` : s`TRUE`;
    case "$exists":
      return value ? s`${col} IS NOT NULL` : s`${col} IS NULL`;
    case "$regex":
      return s`${col}::text ~ ${value}`;
    default:
      throw new Base44Error(`Operador no soportado en ${field}: ${op}`, 400, "BAD_QUERY");
  }
}

function dataCondition(s, field, op, value, options) {
  const j = jsonPath(s, field);
  const text = s`(CASE WHEN jsonb_typeof(${j}) = 'string' THEN ${j} #>> '{}' END)`;
  const number = s`(CASE WHEN jsonb_typeof(${j}) = 'number' THEN (${j})::numeric END)`;
  const compare = (sqlOp) => {
    if (typeof value === "number") return s`${number} ${s.unsafe(sqlOp)} ${value}`;
    if (typeof value === "boolean") return s`(${j}) ${s.unsafe(sqlOp)} ${s.json(value)}`;
    return s`${text} COLLATE "C" ${s.unsafe(sqlOp)} ${String(value)}`;
  };
  switch (op) {
    case "$eq":
      if (value === null) return s`(${j} IS NULL OR ${j} = 'null'::jsonb)`;
      return s`(${j} = ${s.json(value)} OR (jsonb_typeof(${j}) = 'array' AND ${j} @> ${s.json([value])}))`;
    case "$ne":
      return s`NOT COALESCE(${dataCondition(s, field, "$eq", value)}, FALSE)`;
    case "$gt":
      return compare(">");
    case "$gte":
      return compare(">=");
    case "$lt":
      return compare("<");
    case "$lte":
      return compare("<=");
    case "$in":
      return value.length ? s`(${join(s, value.map((v) => dataCondition(s, field, "$eq", v)), "OR")})` : s`FALSE`;
    case "$nin":
      return value.length ? s`NOT COALESCE((${join(s, value.map((v) => dataCondition(s, field, "$eq", v)), "OR")}), FALSE)` : s`TRUE`;
    case "$exists":
      return value ? s`(${j} IS NOT NULL)` : s`(${j} IS NULL)`;
    case "$regex": {
      const insensitive = String(options?.$options || "").includes("i");
      return insensitive ? s`(${j} #>> '{}') ~* ${String(value)}` : s`(${j} #>> '{}') ~ ${String(value)}`;
    }
    case "$all":
      return s`(${j} @> ${s.json(value)})`;
    case "$size":
      return s`(jsonb_typeof(${j}) = 'array' AND jsonb_array_length(${j}) = ${value})`;
    case "$options":
      return s`TRUE`;
    default:
      throw new Base44Error(`Operador no soportado en ${field}: ${op}`, 400, "BAD_QUERY");
  }
}

function isOperatorObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && Object.keys(value).some((k) => k.startsWith("$"));
}

function fieldCondition(s, field, condition) {
  const isColumn = SYSTEM_COLUMNS.has(field);
  const one = (op, value, options) => (isColumn ? columnCondition(s, field, op, normalize(value)) : dataCondition(s, field, op, normalize(value), options));
  if (!isOperatorObject(condition)) return one("$eq", condition);
  const parts = Object.entries(condition).map(([op, value]) => {
    if (op === "$not") return s`NOT COALESCE((${fieldCondition(s, field, value)}), FALSE)`;
    return one(op, value, condition);
  });
  return parts.length ? s`(${join(s, parts, "AND")})` : s`TRUE`;
}

export function whereFor(s, query) {
  if (!query || typeof query !== "object" || Object.keys(query).length === 0) return s`TRUE`;
  const parts = Object.entries(query).map(([key, value]) => {
    if (key === "$and") return s`(${join(s, value.map((q) => whereFor(s, q)), "AND")})`;
    if (key === "$or") return value.length ? s`(${join(s, value.map((q) => whereFor(s, q)), "OR")})` : s`FALSE`;
    if (key === "$nor") return value.length ? s`NOT (${join(s, value.map((q) => whereFor(s, q)), "OR")})` : s`TRUE`;
    return fieldCondition(s, key, value);
  });
  return join(s, parts, "AND");
}

function orderFor(s, sort) {
  const fields = (Array.isArray(sort) ? sort : sort ? [sort] : ["-created_date"]).filter(Boolean);
  const parts = fields.map((raw) => {
    const desc = raw.startsWith("-");
    const field = raw.replace(/^[-+]/, "");
    const expr = SYSTEM_COLUMNS.has(field) ? s(field) : jsonPath(s, field);
    return desc ? s`${expr} DESC NULLS LAST` : s`${expr} ASC NULLS LAST`;
  });
  parts.push(s`id ASC`);
  return join(s, parts, ",");
}

function pick(record, fields) {
  if (!fields || fields.length === 0) return record;
  const list = Array.isArray(fields) ? fields : String(fields).split(",");
  const out = { id: record.id };
  for (const f of list) if (f in record) out[f] = record[f];
  return out;
}

const encodeCursor = (offset) => Buffer.from(String(offset)).toString("base64url");
const decodeCursor = (cursor) => (cursor ? Number(Buffer.from(cursor, "base64url").toString()) || 0 : 0);

async function readArray(entity, query, sort, limit, skip, fields) {
  const s = await db();
  const rows = await s`
    SELECT * FROM ${s(TABLE)}
    WHERE entity = ${entity} AND ${whereFor(s, query)}
    ORDER BY ${orderFor(s, sort)}
    LIMIT ${Math.min(Number(limit) || MAX_ROWS, MAX_ROWS)} OFFSET ${Number(skip) || 0}`;
  return rows.map((row) => pick(toRecord(row), fields));
}

async function readPage(entity, query, options) {
  const s = await db();
  const limit = Math.min(Number(options.limit) || 50, MAX_ROWS);
  const offset = decodeCursor(options.cursor);
  if (options.distinct) {
    const field = options.distinct;
    const expr = SYSTEM_COLUMNS.has(field) ? s`to_jsonb(${s(field)})` : jsonPath(s, field);
    const rows = await s`
      SELECT DISTINCT ${expr} AS value FROM ${s(TABLE)}
      WHERE entity = ${entity} AND ${whereFor(s, query)} AND ${expr} IS NOT NULL
      ORDER BY 1 LIMIT ${limit + 1} OFFSET ${offset}`;
    const items = rows.slice(0, limit).map((r) => r.value);
    return { items, next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null, has_more: rows.length > limit };
  }
  const rows = await s`
    SELECT * FROM ${s(TABLE)}
    WHERE entity = ${entity} AND ${whereFor(s, query)}
    ORDER BY ${orderFor(s, options.sort)}
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const items = rows.slice(0, limit).map((row) => pick(toRecord(row), options.fields));
  return { items, next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null, has_more: rows.length > limit };
}

const isPageOptions = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

async function getRow(s, entity, id) {
  const [row] = await s`SELECT * FROM ${s(TABLE)} WHERE entity = ${entity} AND id = ${String(id)}`;
  return row;
}

async function insert(s, entity, input, user) {
  const data = withDefaults(entity, splitData(input));
  const id = input?.id ? String(input.id) : newId();
  const [row] = await s`
    INSERT INTO ${s(TABLE)} (entity, id, data, created_by, created_by_id)
    VALUES (${entity}, ${id}, ${s.json(data)}, ${user?.email ?? null}, ${user?.id ?? null})
    RETURNING *`;
  return toRecord(row);
}

async function patch(s, entity, id, input) {
  const [row] = await s`
    UPDATE ${s(TABLE)} SET data = data || ${s.json(splitData(input))}, updated_date = now()
    WHERE entity = ${entity} AND id = ${String(id)}
    RETURNING *`;
  if (!row) throw new Base44Error(`${entity} ${id} no existe`, 404, "NOT_FOUND");
  return toRecord(row);
}

// ---------- agregaciones ----------

function asList(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function numericExpr(s, field) {
  if (SYSTEM_COLUMNS.has(field)) return s`NULL::numeric`;
  const j = jsonPath(s, field);
  return s`(CASE WHEN jsonb_typeof(${j}) = 'number' THEN (${j})::numeric END)`;
}

async function aggregate(entity, spec = {}) {
  const s = await db();
  const select = [];
  const groups = [];
  const numericKeys = [];

  for (const field of asList(spec.groupBy)) {
    const expr = SYSTEM_COLUMNS.has(field) ? s`to_jsonb(${s(field)})` : s`COALESCE(${jsonPath(s, field)}, 'null'::jsonb)`;
    select.push(s`${expr} AS ${s(field)}`);
    groups.push(expr);
  }
  if (spec.dateBucket) {
    const { field, unit = "day" } = spec.dateBucket;
    if (!["day", "week", "month", "year"].includes(unit)) throw new Base44Error(`Unidad de fecha no válida: ${unit}`, 400, "BAD_QUERY");
    const ts = SYSTEM_COLUMNS.has(field)
      ? s(field)
      : s`(CASE WHEN jsonb_typeof(${jsonPath(s, field)}) = 'string' THEN (${jsonPath(s, field)} #>> '{}')::timestamptz END)`;
    const expr = s`to_char(date_trunc(${unit}, ${ts} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    select.push(s`${expr} AS ${s(field)}`);
    groups.push(expr);
  }

  const hasExplicitMetric = spec.sum || spec.avg || spec.min || spec.max || spec.countDistinct;
  if (spec.count !== false && (spec.count === true || !spec.countDistinct || hasExplicitMetric)) {
    select.push(s`count(*)::int AS count`);
  }
  for (const [fn, key] of [["sum", "sum"], ["avg", "avg"], ["min", "min"], ["max", "max"]]) {
    for (const field of asList(spec[key])) {
      const alias = `${fn}_${field}`;
      select.push(s`${s.unsafe(fn)}(${numericExpr(s, field)}) AS ${s(alias)}`);
      numericKeys.push(alias);
    }
  }
  if (spec.countDistinct) {
    const field = spec.countDistinct;
    const expr = SYSTEM_COLUMNS.has(field) ? s(field) : jsonPath(s, field);
    select.push(s`count(DISTINCT ${expr})::int AS ${s(`count_distinct_${field}`)}`);
  }
  if (select.length === 0) select.push(s`count(*)::int AS count`);

  const rows = await s`
    SELECT ${join(s, select, ",")} FROM ${s(TABLE)}
    WHERE entity = ${entity} AND ${whereFor(s, spec.query)}
    ${groups.length ? s`GROUP BY ${s.unsafe(groups.map((_, i) => i + 1).join(", "))}` : s``}`;

  let out = rows.map((row) => {
    const plain = { ...row };
    for (const key of numericKeys) plain[key] = plain[key] == null ? null : Number(plain[key]);
    return plain;
  });
  if (spec.having) out = out.filter((row) => matches(row, spec.having));
  if (spec.sort) {
    const desc = spec.sort.startsWith("-");
    const key = spec.sort.replace(/^[-+]/, "");
    out.sort((a, b) => (desc ? -1 : 1) * compareValues(a[key], b[key]));
  }
  const limit = Math.min(Number(spec.limit) || MAX_AGGREGATE_ROWS, MAX_AGGREGATE_ROWS);
  return { rows: out.slice(0, limit), truncated: out.length > limit };
}

// ---------- la API pública de una entidad ----------

export function entityHandler(entity, user) {
  return {
    async list(sort, limit, skip, fields) {
      return isPageOptions(sort) ? readPage(entity, {}, sort) : readArray(entity, {}, sort, limit, skip, fields);
    },
    async filter(query, sort, limit, skip, fields) {
      return isPageOptions(sort) ? readPage(entity, query, sort) : readArray(entity, query, sort, limit, skip, fields);
    },
    async get(id) {
      const s = await db();
      const row = await getRow(s, entity, id);
      if (!row) throw new Base44Error(`${entity} ${id} no existe`, 404, "NOT_FOUND");
      return toRecord(row);
    },
    async create(data) {
      return insert(await db(), entity, data, user);
    },
    async bulkCreate(list) {
      const s = await db();
      return s.begin(async (tx) => {
        const out = [];
        for (const data of list || []) out.push(await insert(tx, entity, data, user));
        return out;
      });
    },
    async update(id, data) {
      return patch(await db(), entity, id, data);
    },
    async bulkUpdate(list) {
      const s = await db();
      return s.begin(async (tx) => {
        const out = [];
        for (const { id, ...data } of list || []) out.push(await patch(tx, entity, id, data));
        return out;
      });
    },
    async updateMany(query, ops) {
      const s = await db();
      return s.begin(async (tx) => {
        const rows = await tx`
          SELECT * FROM ${tx(TABLE)} WHERE entity = ${entity} AND ${whereFor(tx, query)}
          ORDER BY created_date LIMIT ${MAX_ROWS} FOR UPDATE`;
        for (const row of rows) {
          const next = applyUpdateOps(toRecord(row), ops || {});
          const data = splitData(next);
          await tx`UPDATE ${tx(TABLE)} SET data = ${tx.json(data)}, updated_date = now()
                   WHERE entity = ${entity} AND id = ${row.id}`;
        }
        return { success: true, updated: rows.length, has_more: rows.length === MAX_ROWS };
      });
    },
    async upsert(records, options = {}) {
      const keys = asList(options.key);
      if (keys.length === 0) throw new Base44Error("upsert necesita options.key", 400, "BAD_QUERY");
      const s = await db();
      return s.begin(async (tx) => {
        let created = 0;
        let updated = 0;
        const out = [];
        for (const record of records || []) {
          const query = Object.fromEntries(keys.map((k) => [k, record[k]]));
          const [row] = await tx`SELECT * FROM ${tx(TABLE)} WHERE entity = ${entity} AND ${whereFor(tx, query)} LIMIT 1 FOR UPDATE`;
          if (row) {
            out.push(await patch(tx, entity, row.id, record));
            updated++;
          } else {
            out.push(await insert(tx, entity, record, user));
            created++;
          }
        }
        return { created, updated, records: out };
      });
    },
    async delete(id) {
      const s = await db();
      await s`DELETE FROM ${s(TABLE)} WHERE entity = ${entity} AND id = ${String(id)}`;
      return { success: true };
    },
    async deleteMany(query) {
      const s = await db();
      const rows = await s`DELETE FROM ${s(TABLE)} WHERE entity = ${entity} AND ${whereFor(s, query)} RETURNING id`;
      return { success: true, deleted: rows.length };
    },
    async count(query) {
      const s = await db();
      const [row] = await s`SELECT count(*)::int AS count FROM ${s(TABLE)} WHERE entity = ${entity} AND ${whereFor(s, query)}`;
      return row.count;
    },
    aggregate(spec) {
      return aggregate(entity, spec);
    },
    async importEntities() {
      throw new Base44Error("importEntities no está disponible fuera de Base44.", 501, "NOT_SUPPORTED");
    },
    subscribe() {
      // Sin tiempo real en Vercel: se devuelve una función para cancelar que no hace nada.
      return () => {};
    },
  };
}

export function entitiesModule(user) {
  const cache = new Map();
  return new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== "string" || name === "then") return undefined;
        if (!cache.has(name)) cache.set(name, entityHandler(name, user));
        return cache.get(name);
      },
    },
  );
}
