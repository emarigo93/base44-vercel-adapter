// Evaluación en JavaScript de filtros y operadores de actualización estilo Base44/MongoDB.
// Se usa para `having` en agregaciones y para `updateMany`.

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

function getPath(record, field) {
  return field.split(".").reduce((value, key) => (value == null ? undefined : value[key]), record);
}

function setPath(record, field, value) {
  const keys = field.split(".");
  let target = record;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(target[key])) target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

function unsetPath(record, field) {
  const keys = field.split(".");
  let target = record;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(target[key])) return;
    target = target[key];
  }
  delete target[keys.at(-1)];
}

export function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function matchValue(value, condition) {
  if (!isPlainObject(condition) || !Object.keys(condition).some((k) => k.startsWith("$"))) {
    if (Array.isArray(value) && !Array.isArray(condition)) return value.some((v) => equal(v, condition));
    return equal(value ?? null, condition ?? null);
  }
  return Object.entries(condition).every(([op, arg]) => {
    switch (op) {
      case "$eq":
        return matchValue(value, arg);
      case "$ne":
        return !matchValue(value, arg);
      case "$gt":
        return value != null && compareValues(value, arg) > 0;
      case "$gte":
        return value != null && compareValues(value, arg) >= 0;
      case "$lt":
        return value != null && compareValues(value, arg) < 0;
      case "$lte":
        return value != null && compareValues(value, arg) <= 0;
      case "$in":
        return arg.some((v) => matchValue(value, v));
      case "$nin":
        return !arg.some((v) => matchValue(value, v));
      case "$exists":
        return arg ? value !== undefined : value === undefined;
      case "$regex":
        return typeof value === "string" && new RegExp(arg, String(condition.$options || "").includes("i") ? "i" : "").test(value);
      case "$options":
        return true;
      case "$all":
        return Array.isArray(value) && arg.every((v) => value.some((x) => equal(x, v)));
      case "$size":
        return Array.isArray(value) && value.length === arg;
      case "$not":
        return !matchValue(value, arg);
      default:
        throw new Error(`Operador no soportado: ${op}`);
    }
  });
}

export function matches(record, query) {
  if (!query) return true;
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$and") return condition.every((q) => matches(record, q));
    if (key === "$or") return condition.some((q) => matches(record, q));
    if (key === "$nor") return !condition.some((q) => matches(record, q));
    return matchValue(getPath(record, key), condition);
  });
}

export function applyUpdateOps(record, ops) {
  const next = structuredClone(record);
  const hasOperators = Object.keys(ops).some((k) => k.startsWith("$"));
  if (!hasOperators) return { ...next, ...ops };
  for (const [op, fields] of Object.entries(ops)) {
    for (const [field, arg] of Object.entries(fields || {})) {
      const current = getPath(next, field);
      switch (op) {
        case "$set":
          setPath(next, field, arg);
          break;
        case "$unset":
          unsetPath(next, field);
          break;
        case "$inc":
          setPath(next, field, (Number(current) || 0) + Number(arg));
          break;
        case "$mul":
          setPath(next, field, (Number(current) || 0) * Number(arg));
          break;
        case "$min":
          if (current === undefined || compareValues(arg, current) < 0) setPath(next, field, arg);
          break;
        case "$max":
          if (current === undefined || compareValues(arg, current) > 0) setPath(next, field, arg);
          break;
        case "$currentDate":
          setPath(next, field, new Date().toISOString());
          break;
        case "$rename":
          if (current !== undefined) {
            unsetPath(next, field);
            setPath(next, arg, current);
          }
          break;
        case "$push": {
          const list = Array.isArray(current) ? current : [];
          const items = isPlainObject(arg) && Array.isArray(arg.$each) ? arg.$each : [arg];
          setPath(next, field, [...list, ...items]);
          break;
        }
        case "$addToSet": {
          const list = Array.isArray(current) ? [...current] : [];
          const items = isPlainObject(arg) && Array.isArray(arg.$each) ? arg.$each : [arg];
          for (const item of items) if (!list.some((x) => equal(x, item))) list.push(item);
          setPath(next, field, list);
          break;
        }
        case "$pull": {
          const list = Array.isArray(current) ? current : [];
          setPath(next, field, list.filter((x) => !(isPlainObject(arg) ? matches(x, arg) : equal(x, arg))));
          break;
        }
        default:
          throw new Error(`Operador de actualización no soportado: ${op}`);
      }
    }
  }
  return next;
}
