import fs from 'node:fs/promises';
import path from 'node:path';

const env = (name, fallback = '') => process.env[name] || fallback;
const required = (name) => {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const repositoryConfig = JSON.parse(await fs.readFile(path.resolve('config/report-config.json'), 'utf8'));

const CONFIG = {
  store: required('SHOPIFY_STORE').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  token: required('SHOPIFY_TOKEN'),
  apiVersion: repositoryConfig.shopifyApiVersion || '2026-07',
  locationId: String(repositoryConfig.locationId || '67063775290'),
  locationName: repositoryConfig.locationName || 'Corro Trailer 1',
  orderTags: (repositoryConfig.orderTags || ['SiloRidge']).map(String),
  canonicalTag: repositoryConfig.canonicalTag || 'SiloRidge',
  scanStart: repositoryConfig.scanStart || '2026-09-01',
  fallbackEventStart: repositoryConfig.fallbackEventStart || '2026-09-28',
  defaultOpex: Number(repositoryConfig.defaultOpex || 5000),
  timezone: repositoryConfig.timezone || 'America/New_York'
};

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const money = (set, fallback = 0) => round2(set?.shopMoney?.amount ?? fallback);
const numericId = (gid = '') => String(gid).split('/').pop();
const nodes = (connection) => (connection?.edges || []).map((e) => e.node).filter(Boolean);
const isoDay = (d) => d.toISOString().slice(0, 10);
const dateOnly = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00Z`);

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function startOfMonday(value) {
  const d = dateOnly(value);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function graphql(query, variables) {
  const response = await fetch(`https://${CONFIG.store}/admin/api/${CONFIG.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': CONFIG.token
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Shopify GraphQL HTTP ${response.status}: ${text.slice(0, 1200)}`);
  const body = JSON.parse(text);
  if (body.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

const ORDER_QUERY = `
query SiloRidgeOrders($cursor: String, $q: String!, $first: Int!, $lineFirst: Int!) {
  orders(first: $first, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: false) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name tags createdAt sourceName displayFinancialStatus displayFulfillmentStatus cancelledAt
      physicalLocation { id name }
      fulfillments(first: 20) { location { id name } }
      customer { firstName lastName email }
      currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      netPaymentSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      lineItems(first: $lineFirst) { edges { node {
        id title quantity currentQuantity sku variantTitle
        originalTotalSet { shopMoney { amount currencyCode } }
        discountedTotalSet { shopMoney { amount currencyCode } }
        totalDiscountSet { shopMoney { amount currencyCode } }
        variant { id sku inventoryItem { id unitCost { amount currencyCode } } }
      } } }
    } }
  }
}`;

async function fetchOrders(startISO, endISO) {
  const all = [];
  let cursor = null;
  const q = `status:any created_at:>=${startISO} created_at:<=${endISO}`;
  do {
    const data = await graphql(ORDER_QUERY, { cursor, q, first: 75, lineFirst: 100 });
    const connection = data.orders;
    all.push(...nodes(connection));
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

function locationInfo(order) {
  const physical = order.physicalLocation || {};
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : nodes(order.fulfillments);
  const locations = [physical, ...(fulfillments || []).map((f) => f.location)].filter(Boolean);
  const targetName = CONFIG.locationName.toLowerCase();
  const targetId = CONFIG.locationId;
  const match = locations.some((l) => {
    const name = String(l.name || '').toLowerCase();
    return numericId(l.id) === targetId || name === targetName || name.includes(targetName);
  });
  return {
    match,
    names: [...new Set(locations.map((l) => l.name).filter(Boolean))],
    display: [...new Set(locations.map((l) => l.name).filter(Boolean))].join(', ') || 'No Shopify location returned'
  };
}

function tagInfo(order) {
  const tags = (order.tags || []).map((t) => String(t).trim());
  const normalized = tags.map((t) => t.toLowerCase().replace(/[\s_-]+/g, ''));
  const aliases = CONFIG.orderTags.map((t) => t.toLowerCase().replace(/[\s_-]+/g, ''));
  const matchIndex = normalized.findIndex((tag) => aliases.includes(tag));
  return {
    match: matchIndex >= 0,
    matchedTag: matchIndex >= 0 ? tags[matchIndex] : '',
    tags
  };
}

function qualifies(order) {
  const location = locationInfo(order);
  const tag = tagInfo(order);
  const cancelled = Boolean(order.cancelledAt);
  return { include: !cancelled && location.match && tag.match, location, tag, cancelled };
}


function orderSummary(order) {
  const items = nodes(order.lineItems).filter((item) => {
    const title = String(item.title || '').toLowerCase();
    return !title.includes('shipping protection') && title !== 'shipping';
  });

  const grossSales = round2(items.reduce((sum, item) => sum + money(item.originalTotalSet), 0));
  const discounts = round2(items.reduce((sum, item) => sum + money(item.totalDiscountSet), 0));
  const netSales = money(order.currentSubtotalPriceSet);
  const returns = round2(Math.max(0, grossSales - discounts - netSales));
  const units = items.reduce((sum, item) => sum + Number(item.currentQuantity ?? item.quantity ?? 0), 0);
  const cogs = round2(items.reduce((sum, item) => {
    const unitCost = Number(item.variant?.inventoryItem?.unitCost?.amount || 0);
    const currentQty = Number(item.currentQuantity ?? item.quantity ?? 0);
    return sum + unitCost * currentQty;
  }, 0));
  const grossProfit = round2(netSales - cogs);
  const q = qualifies(order);

  return {
    order_id: order.name || numericId(order.id),
    order_date: order.createdAt,
    tags: order.tags || [],
    matched_tag: q.tag.matchedTag,
    location: q.location.display,
    customer: `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() || 'N/A',
    customer_email: order.customer?.email || '',
    payment_status: order.displayFinancialStatus || 'UNKNOWN',
    fulfillment_status: order.displayFulfillmentStatus || 'UNKNOWN',
    gross_sales: grossSales,
    discounts,
    returns,
    net_sales: round2(netSales),
    cogs,
    gross_profit: grossProfit,
    gross_margin: netSales > 0 ? grossProfit / netSales : 0,
    units,
    shipping: money(order.totalShippingPriceSet),
    taxes: money(order.totalTaxSet),
    total_sales: money(order.netPaymentSet, netSales + money(order.totalShippingPriceSet) + money(order.totalTaxSet))
  };
}

function blankActual() {
  return { gross_sales: 0, discounts: 0, returns: 0, net_sales: 0, cogs: 0, gross_profit: 0, orders: 0, units: 0 };
}

function addToActual(actual, order) {
  for (const key of ['gross_sales','discounts','returns','net_sales','cogs','gross_profit','units']) {
    actual[key] += Number(order[key] || 0);
  }
  actual.orders += 1;
}

function finalizeActual(actual) {
  for (const key of ['gross_sales','discounts','returns','net_sales','cogs','gross_profit','units']) {
    actual[key] = round2(actual[key]);
  }
  actual.gross_margin = actual.net_sales > 0 ? actual.gross_profit / actual.net_sales : 0;
  actual.units_per_order = actual.orders > 0 ? actual.units / actual.orders : 0;
  actual.aov = actual.orders > 0 ? actual.net_sales / actual.orders : 0;
  return actual;
}

function buildWeeks(orders) {
  const firstOrderDate = orders.length ? orders.map((o) => o.order_date).sort()[0] : null;
  const anchor = firstOrderDate || CONFIG.fallbackEventStart;
  const firstMonday = startOfMonday(anchor);

  const lastOrderDate = orders.length ? orders.map((o) => o.order_date).sort().at(-1) : null;
  const today = todayISO();
  const lastAnchor = lastOrderDate || CONFIG.fallbackEventStart;
  const effectiveLast = dateOnly(lastAnchor) > dateOnly(today) ? lastAnchor : today;
  let lastMonday = startOfMonday(effectiveLast);
  if (lastMonday < firstMonday) lastMonday = new Date(firstMonday);

  const weeks = [];
  let cursor = new Date(firstMonday);
  let weekNum = 1;
  while (cursor <= lastMonday) {
    const start = isoDay(cursor);
    const end = isoDay(addDays(cursor, 6));
    const actual = blankActual();
    for (const order of orders) {
      const d = dateOnly(order.order_date);
      if (d >= dateOnly(start) && d <= dateOnly(end)) addToActual(actual, order);
    }
    weeks.push({ week: weekNum++, startISO: start, endISO: end, actual: finalizeActual(actual) });
    cursor = addDays(cursor, 7);
  }

  // Before the event starts, show only the draft Week 1 instead of many empty pre-event weeks.
  if (!orders.length) return weeks.slice(0, 1);
  return weeks;
}

function buildReport(rawOrders) {
  const stats = {
    scanned: rawOrders.length,
    matched: 0,
    excluded_wrong_location: 0,
    excluded_missing_tag: 0,
    excluded_cancelled: 0
  };
  const orders = [];

  for (const order of rawOrders) {
    const q = qualifies(order);
    if (!q.include) {
      if (!q.location.match) stats.excluded_wrong_location++;
      if (!q.tag.match) stats.excluded_missing_tag++;
      if (q.cancelled) stats.excluded_cancelled++;
      continue;
    }
    orders.push(orderSummary(order));
    stats.matched++;
  }

  const total = blankActual();
  for (const order of orders) addToActual(total, order);
  finalizeActual(total);
  const weeks = buildWeeks(orders);

  return {
    generated_at: new Date().toISOString(),
    report_name: 'Silo Ridge Sales Performance',
    config: {
      location_id: CONFIG.locationId,
      location_name: CONFIG.locationName,
      canonical_tag: CONFIG.canonicalTag,
      accepted_tag_variants: CONFIG.orderTags,
      scan_start: CONFIG.scanStart,
      fallback_event_start: CONFIG.fallbackEventStart,
      default_opex: CONFIG.defaultOpex,
      api_version: CONFIG.apiVersion,
      inclusion_rule: `Strict AND: Shopify location ${CONFIG.locationName} AND Silo Ridge order tag`
    },
    total,
    weeks,
    orders,
    stats,
    formulas: {
      net_sales: 'Gross Sales − Discounts − Returns',
      gross_profit: 'Net Sales − COGS',
      gm1: 'Gross Profit ÷ Net Sales',
      units_per_order: 'Units ÷ Orders',
      aov: 'Net Sales ÷ Orders',
      profit_after_opex: 'Gross Profit − Manual Total OPEX',
      opex_coverage: 'Gross Profit ÷ Manual Total OPEX'
    },
    methodology: 'Shopify is the financial source of truth. Orders qualify only when they are tied to Corro Trailer 1 and carry a Silo Ridge tag. Total OPEX is a manual event-level input and excludes inventory/COGS.'
  };
}

async function main() {
  const endISO = todayISO();
  const rawOrders = await fetchOrders(CONFIG.scanStart, endISO);
  const report = buildReport(rawOrders);
  const out = path.resolve('docs/report-data.json');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Generated ${out}: ${report.stats.matched} Silo Ridge orders matched from ${CONFIG.scanStart} through ${endISO}.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
